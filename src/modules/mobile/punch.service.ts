import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  LIVENESS_STEPS,
  type LivenessStep,
  type LocationFix,
  popMessages,
  type PunchCommitInput,
  type PunchRejectReason,
  type SelfieUploadRequest,
} from '@attendance/contracts';
import { requireEmployee, requireTenantId } from '../../core/context/request-context.js';
import { verifyDeviceSignature } from '../../core/crypto/crypto.util.js';
import { DbService } from '../../core/database/db.service.js';
import { AppError } from '../../core/http/app-error.js';
import { CacheService } from '../../core/redis/cache.service.js';
import { StorageService } from '../../core/storage/storage.service.js';
import { iso } from '../../common/serialize.js';
import { punchGate, classifyDay } from '../../engines/attendance/calendar.js';
import { attributePunch, shiftInstance } from '../../engines/attendance/shift.js';
import { checkGeofence, type GeofenceSite } from '../../engines/geo/geofence.js';
import { type IsoDate, toDbDate } from '../../engines/time/dates.js';
import { AttendanceDayService } from '../attendance/attendance-day.service.js';
import { DayInputsLoader, type DayInputs } from '../attendance/day-inputs.loader.js';
import { MobileAuthService } from './mobile-auth.service.js';

const INTENT_TTL_SEC = 300;
const MAX_PUNCHES_PER_DAY = 100;
const LIVENESS_MIN_MS = 500;
const LIVENESS_MAX_MS = 60_000;

interface Intent {
  readonly intentId: string;
  readonly employeeId: string;
  readonly bindingId: string;
  readonly tenantId: string;
  readonly date: IsoDate;
  readonly siteId: string;
  readonly distanceM: number;
  readonly challenge: LivenessStep[];
  readonly selfieKey: string;
  readonly selfieSha256?: string;
  readonly selfieSize?: number;
}

interface DayContext {
  readonly date: IsoDate;
  readonly inputs: DayInputs;
  readonly dayType: 'WORKING' | 'WEEKLY_OFF' | 'HOLIDAY';
  readonly timezone: string;
  readonly sites: GeofenceSite[];
  readonly accuracyBufferCapM: number;
  readonly outOfWindow: boolean;
}

function randomChallenge(): LivenessStep[] {
  const pool = [...LIVENESS_STEPS].sort(() => Math.random() - 0.5);
  return pool.slice(0, 2);
}

@Injectable()
export class PunchService {
  constructor(
    private readonly db: DbService,
    private readonly loader: DayInputsLoader,
    private readonly days: AttendanceDayService,
    private readonly cache: CacheService,
    private readonly storage: StorageService,
    private readonly auth: MobileAuthService,
  ) {}

  async context() {
    const { employeeId } = requireEmployee();
    const ctx = await this.dayContext(employeeId, new Date());
    const gate = this.gate(ctx);
    const day = await this.db.tenant.attendanceDay.findUnique({
      where: { employeeId_attendanceDate: { employeeId, attendanceDate: toDbDate(ctx.date) } },
    });
    const punches = await this.db.tenant.punch.findMany({
      where: { employeeId, attendanceDate: toDbDate(ctx.date), voidedAt: null },
      orderBy: { serverTime: 'asc' },
      select: { serverTime: true, direction: true },
    });
    const instance = shiftInstance(ctx.date, ctx.inputs.shift, ctx.timezone);
    return {
      serverTime: new Date().toISOString(),
      date: ctx.date,
      dayType: ctx.dayType,
      holidayName: ctx.inputs.holiday?.name ?? null,
      punchAllowed: gate.allowed,
      blockedReason: gate.allowed ? null : gate.reason,
      shift: ctx.inputs.shift
        ? { startAt: iso(instance.startAt), endAt: iso(instance.endAt), startTime: ctx.inputs.shift.startTime, endTime: ctx.inputs.shift.endTime }
        : null,
      sites: ctx.sites.map((s) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng, radiusM: s.radiusM })),
      minPunchGapSec: ctx.inputs.policy.minPunchGapSec,
      nextDirection: punches.length % 2 === 0 ? 'IN' : 'OUT',
      punches: punches.map((p) => ({ at: iso(p.serverTime), direction: p.direction })),
      today: day
        ? { status: day.finalStatus, workedMinutes: day.workedMinutes, isLate: day.isLate, firstPunchAt: iso(day.firstPunchAt), lastPunchAt: iso(day.lastPunchAt) }
        : { status: 'NOT_STARTED', workedMinutes: 0, isLate: false, firstPunchAt: null, lastPunchAt: null },
    };
  }

  async intent(fix: LocationFix) {
    const { employeeId, bindingId } = requireEmployee();
    const tenantId = requireTenantId();
    await this.cache.limit(`punch:intent:${employeeId}`, 6, 60);
    const ctx = await this.dayContext(employeeId, new Date());
    const gate = this.gate(ctx);
    if (!gate.allowed) throw await this.rejection(employeeId, bindingId, 'INTENT', gate.reason, fix);
    if (fix.isMock && ctx.inputs.policy.blockMockLocation) throw await this.rejection(employeeId, bindingId, 'INTENT', 'MOCK_LOCATION', fix);
    const geo = checkGeofence(fix, ctx.sites, ctx.accuracyBufferCapM);
    if (!geo.ok) throw await this.rejection(employeeId, bindingId, 'INTENT', geo.reason, fix, geo.nearest);
    await this.assertGap(employeeId, ctx.inputs.policy.minPunchGapSec);
    const intentId = randomUUID();
    const [yyyy, mm, dd] = ctx.date.split('-');
    const intent: Intent = {
      intentId,
      employeeId,
      bindingId,
      tenantId,
      date: ctx.date,
      siteId: geo.site.id,
      distanceM: geo.distanceM,
      challenge: randomChallenge(),
      selfieKey: `t/${tenantId}/selfies/${yyyy}/${mm}/${dd}/${intentId}.jpg`,
    };
    await this.cache.setJson(`pi:${intentId}`, intent, INTENT_TTL_SEC);
    return { intentId, livenessChallenge: intent.challenge, expiresInSec: INTENT_TTL_SEC, site: { id: geo.site.id, name: geo.site.name }, distanceM: geo.distanceM };
  }

  async selfieUpload(input: SelfieUploadRequest) {
    const intent = await this.ownIntent(input.intentId);
    const upload = await this.storage.presignPut(intent.selfieKey, 'image/jpeg', input.sizeBytes, 120);
    await this.cache.setJson(`pi:${intent.intentId}`, { ...intent, selfieSha256: input.sha256, selfieSize: input.sizeBytes }, INTENT_TTL_SEC);
    return upload;
  }

  async commit(input: PunchCommitInput) {
    const { employeeId, bindingId } = requireEmployee();
    const intent = await this.ownIntent(input.intentId);
    await this.auth.consumeNonce(input.nonce);
    const binding = await this.db.tenant.deviceBinding.findUnique({ where: { id: bindingId } });
    const message = popMessages.punch(input.nonce, input.intentId, input.selfieSha256, input.lat, input.lng);
    if (!binding || !verifyDeviceSignature(binding.publicKeySpki, message, input.signature)) {
      throw await this.rejection(employeeId, bindingId, 'COMMIT', 'BAD_SIGNATURE', input);
    }
    this.assertLiveness(input, intent);
    const existing = await this.db.tenant.punch.findUnique({ where: { id: intent.intentId } });
    if (existing) return this.result(existing.employeeId, existing.attendanceDate.toISOString().slice(0, 10), existing);
    const head = await this.storage.head(intent.selfieKey);
    if (!head || head.sizeBytes < 10_000 || (intent.selfieSize && head.sizeBytes !== intent.selfieSize) || intent.selfieSha256 !== input.selfieSha256) {
      throw await this.rejection(employeeId, bindingId, 'COMMIT', 'SELFIE_MISSING', input);
    }
    const now = new Date();
    const ctx = await this.dayContext(employeeId, now);
    const gate = this.gate(ctx);
    if (!gate.allowed) throw await this.rejection(employeeId, bindingId, 'COMMIT', gate.reason, input);
    if (input.isMock && ctx.inputs.policy.blockMockLocation) throw await this.rejection(employeeId, bindingId, 'COMMIT', 'MOCK_LOCATION', input);
    const geo = checkGeofence(input, ctx.sites, ctx.accuracyBufferCapM);
    if (!geo.ok) throw await this.rejection(employeeId, bindingId, 'COMMIT', geo.reason, input, geo.nearest);
    await this.assertGap(employeeId, ctx.inputs.policy.minPunchGapSec);
    const deviceTime = new Date(input.deviceTime);
    const skew = Math.round((deviceTime.getTime() - now.getTime()) / 1000);
    const flags = [
      Math.abs(skew) > 300 ? 'CLOCK_SKEW' : null,
      ctx.outOfWindow ? 'OUT_OF_SHIFT_WINDOW' : null,
      input.isMock ? 'MOCK_LOCATION' : null,
    ].filter((f): f is string => f !== null);

    const punch = await this.db.tenant.$transaction(async (tx) => {
      await this.db.lock(tx, `punch:${employeeId}`);
      const count = await tx.punch.count({ where: { employeeId, attendanceDate: toDbDate(ctx.date), voidedAt: null } });
      if (count >= MAX_PUNCHES_PER_DAY) throw new AppError('RATE_LIMITED', 'Daily punch limit reached.');
      const row = await tx.punch.create({
        data: {
          id: intent.intentId,
          tenantId: intent.tenantId,
          employeeId,
          bindingId,
          attendanceDate: toDbDate(ctx.date),
          sequenceNo: count + 1,
          direction: count % 2 === 0 ? 'IN' : 'OUT',
          serverTime: now,
          deviceTime,
          clockSkewSec: skew,
          lat: input.lat,
          lng: input.lng,
          accuracyM: input.accuracyM,
          isMock: input.isMock,
          siteId: geo.site.id,
          distanceM: geo.distanceM,
          selfieKey: intent.selfieKey,
          selfieSha256: input.selfieSha256,
          liveness: { ...input.liveness, challenge: intent.challenge },
          flags,
          appVersion: binding?.appVersion ?? null,
        },
      });
      await this.days.recomputeDay(employeeId, ctx.date, tx);
      return row;
    });
    await this.cache.del(`pi:${intent.intentId}`);
    await this.db.tenant.deviceBinding.update({ where: { id: bindingId }, data: { lastSeenAt: now } });
    return this.result(employeeId, ctx.date, punch);
  }

  private async result(employeeId: string, date: IsoDate, punch: { id: string; direction: string; serverTime: Date; sequenceNo: number }) {
    const day = await this.db.tenant.attendanceDay.findUnique({ where: { employeeId_attendanceDate: { employeeId, attendanceDate: toDbDate(date) } } });
    return {
      punch: { id: punch.id, direction: punch.direction, at: iso(punch.serverTime), sequenceNo: punch.sequenceNo },
      day: day ? { date, status: day.finalStatus, workedMinutes: day.workedMinutes, isLate: day.isLate, punchCount: day.punchCount } : null,
    };
  }

  private async ownIntent(intentId: string): Promise<Intent> {
    const intent = await this.cache.getJson<Intent>(`pi:${intentId}`);
    if (!intent || intent.employeeId !== requireEmployee().employeeId) throw new AppError('INTENT_EXPIRED');
    return intent;
  }

  private assertLiveness(input: PunchCommitInput, intent: Intent): void {
    const l = input.liveness;
    const ok =
      l.passed &&
      l.faceCount === 1 &&
      l.durationMs >= LIVENESS_MIN_MS &&
      l.durationMs <= LIVENESS_MAX_MS &&
      l.steps.length === intent.challenge.length &&
      l.steps.every((step, i) => step === intent.challenge[i]);
    if (!ok) throw new AppError('LIVENESS_INVALID');
  }

  private async assertGap(employeeId: string, minGapSec: number): Promise<void> {
    const last = await this.db.tenant.punch.findFirst({ where: { employeeId, voidedAt: null }, orderBy: { serverTime: 'desc' }, select: { serverTime: true } });
    if (last && Date.now() - last.serverTime.getTime() < minGapSec * 1000) throw new AppError('PUNCH_TOO_SOON');
  }

  private gate(ctx: DayContext) {
    return punchGate(ctx.dayType, ctx.inputs.leave?.fraction === 1, ctx.inputs.override?.allowPunch ?? false);
  }

  private async dayContext(employeeId: string, at: Date): Promise<DayContext> {
    const tenantId = requireTenantId();
    const [tenant, settings, employee] = await Promise.all([
      this.db.platform.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } }),
      this.db.tenant.tenantSettings.findUniqueOrThrow({ where: { tenantId } }),
      this.db.tenant.employee.findUniqueOrThrow({ where: { id: employeeId }, include: { sites: { include: { site: true } } } }),
    ]);
    const today = at.toISOString().slice(0, 10);
    // Load two days so overnight shifts can attribute an early-morning punch to yesterday.
    const probe = await this.loader.load(employeeId, this.shiftDate(at, tenant.timezone, -1), this.shiftDate(at, tenant.timezone, 0));
    if (!probe) throw new AppError('EMPLOYEE_INACTIVE');
    const attribution = attributePunch(at, tenant.timezone, (date) => probe.days.get(date)?.shift ?? null);
    const inputs = probe.days.get(attribution.date) ?? probe.days.get(today);
    if (!inputs) throw new AppError('INTERNAL_ERROR');
    const cls = classifyDay(attribution.date, inputs.holiday, inputs.weeklyOffRules);
    const siteRows =
      employee.geofenceMode === 'ANY_TENANT_SITE' ? await this.db.tenant.site.findMany({ where: { active: true } }) : employee.sites.map((s) => s.site).filter((s) => s.active);
    return {
      date: attribution.date,
      inputs,
      dayType: cls.dayType,
      timezone: tenant.timezone,
      sites: siteRows.map((s) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng, radiusM: s.radiusM, maxAccuracyM: s.maxAccuracyM })),
      accuracyBufferCapM: settings.accuracyBufferCapM,
      outOfWindow: attribution.outOfWindow,
    };
  }

  private shiftDate(at: Date, timezone: string, offsetDays: number): IsoDate {
    const local = new Date(at.toLocaleString('en-US', { timeZone: timezone }));
    local.setDate(local.getDate() + offsetDays);
    return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
  }

  private async rejection(
    employeeId: string,
    bindingId: string,
    stage: 'INTENT' | 'COMMIT',
    reason: PunchRejectReason,
    fix: LocationFix,
    nearest?: { site: GeofenceSite; distanceM: number },
  ): Promise<AppError> {
    await this.db.tenant.punchRejection.create({
      data: {
        tenantId: requireTenantId(),
        employeeId,
        bindingId,
        stage,
        reasonCode: reason,
        lat: fix.lat,
        lng: fix.lng,
        accuracyM: fix.accuracyM,
        isMock: fix.isMock,
        nearestSiteId: nearest?.site.id ?? null,
        distanceM: nearest?.distanceM ?? null,
      },
    });
    const details = nearest ? { nearestSite: nearest.site.name, distanceM: nearest.distanceM, radiusM: nearest.site.radiusM } : undefined;
    return new AppError(reason, undefined, details);
  }
}
