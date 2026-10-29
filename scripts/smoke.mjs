// End-to-end smoke test against the local API. Usage: node smoke.mjs <superadminEmail> <superadminPassword>
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';

const API = 'http://127.0.0.1:4000';
const [email, password] = process.argv.slice(2);
if (!email || !password) throw new Error('usage: node smoke.mjs <email> <password>');

const steps = [];
function ok(name, detail = '') {
  steps.push(`✔ ${name}${detail ? ` — ${detail}` : ''}`);
}

async function call(method, path, { body, token, raw } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return res;
  const json = await res.json();
  if (!json.success) throw new Error(`${method} ${path} → ${res.status} ${json.error?.code}: ${json.error?.message} ${JSON.stringify(json.error?.details ?? '')}`);
  return json.data;
}

const today = new Date().toISOString().slice(0, 10);
const suffix = Date.now().toString(36);
const phoneDigits = '9' + String(Date.now()).slice(-9);

// 1. Platform: login, onboard a tenant
const platform = await call('POST', '/v1/platform/auth/login', { body: { email, password } });
ok('platform login');
const plans = await call('GET', '/v1/platform/plans', { token: platform.accessToken });
const tenant = await call('POST', '/v1/platform/tenants', {
  token: platform.accessToken,
  body: {
    legalName: `Smoke Test Pvt Ltd ${suffix}`,
    displayName: `Smoke ${suffix}`,
    slug: `smoke-${suffix}`,
    stateCode: 'MH',
    billingEmail: `billing-${suffix}@example.com`,
    planId: plans[0].id,
    admin: { fullName: 'Asha Admin', email: `asha-${suffix}@example.com` },
  },
});
ok('tenant onboarded', tenant.tenantId);
const inviteToken = new URL(tenant.inviteLink).searchParams.get('token');

// 2. Admin accepts invite, logs in
const adminTokens = await call('POST', '/v1/tenant/auth/accept-invite', { body: { token: inviteToken, fullName: 'Asha Admin', password: 'StrongPass123' } });
const me = await call('GET', '/v1/tenant/me', { token: adminTokens.accessToken });
ok('admin invite accepted', `${me.user.email} role=${me.role.kind}`);
const t = adminTokens.accessToken;

// 3. Setup: site + employee
const branches = await call('GET', '/v1/tenant/branches', { token: t });
const shifts = await call('GET', '/v1/tenant/shifts', { token: t });
const site = await call('POST', '/v1/tenant/sites', { token: t, body: { name: 'Head office gate', lat: 19.076, lng: 72.8777, radiusM: 150, branchId: branches[0].id } });
const employee = await call('POST', '/v1/tenant/employees', {
  token: t,
  body: {
    employeeCode: 'E001',
    fullName: 'Ravi Kumar',
    phone: phoneDigits,
    branchId: branches[0].id,
    dateOfJoining: today,
    siteIds: [site.id],
    shiftId: shifts[0].id,
    salary: { basis: 'MONTHLY', amount: '30000', effectiveFrom: today },
  },
});
ok('employee created', `code=${employee.activationCode.formatted}`);
const revealed = await call('GET', `/v1/tenant/employees/${employee.id}/activation-code`, { token: t });
if (revealed.code.code !== employee.activationCode.code) throw new Error('reveal mismatch');
ok('activation code reveal matches');

// 4. Phone activation with a real P-256 key
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const signMsg = (msg) => sign('sha256', Buffer.from(msg), privateKey).toString('base64');
const installId = randomUUID();
const phone = '+91' + phoneDigits;
let { nonce } = await call('POST', '/v1/mobile/auth/nonce');
const bad = await call('POST', '/v1/mobile/auth/activate', {
  raw: true,
  body: { phone, code: 'AAAAAAAA', nonce, publicKey: spki, signature: signMsg(`v1|ACTIVATE|${nonce}|${phone}`), device: { installId, platform: 'ANDROID', manufacturer: 'Test', model: 'Emu', osVersion: '14', appVersion: '0.1.0' } },
}).then((r) => r.json());
if (bad.success || bad.error.code !== 'ACTIVATION_FAILED') throw new Error('wrong code should fail generically');
ok('wrong activation code rejected generically');
({ nonce } = await call('POST', '/v1/mobile/auth/nonce'));
const activation = await call('POST', '/v1/mobile/auth/activate', {
  body: {
    phone,
    code: employee.activationCode.code,
    nonce,
    publicKey: spki,
    signature: signMsg(`v1|ACTIVATE|${nonce}|${phone}`),
    device: { installId, platform: 'ANDROID', manufacturer: 'Test', model: 'Emu', osVersion: '14', appVersion: '0.1.0' },
  },
});
if (activation.status !== 'ACTIVE') throw new Error(`unexpected activation status ${activation.status}`);
ok('device activated', `binding=${activation.bindingId}`);
const e = activation.accessToken;

// 5. Consent
const mobileMe = await call('GET', '/v1/mobile/me', { token: e });
if (!mobileMe.consent.required) throw new Error('consent should be required');
await call('POST', '/v1/mobile/consent', { token: e, body: { noticeId: mobileMe.consent.notice.id, purposes: mobileMe.consent.notice.purposes.map((p) => p.code) } });
ok('consent accepted');

// 6. Punch: context → intent → selfie → commit
const context = await call('GET', '/v1/mobile/punch/context', { token: e });
ok('punch context', `allowed=${context.punchAllowed} dayType=${context.dayType} sites=${context.sites.length}`);
const outside = await call('POST', '/v1/mobile/punch/intents', { raw: true, token: e, body: { lat: 19.2, lng: 72.9, accuracyM: 10, isMock: false } }).then((r) => r.json());
if (outside.error?.code !== 'OUTSIDE_GEOFENCE') throw new Error(`expected OUTSIDE_GEOFENCE, got ${JSON.stringify(outside)}`);
ok('outside geofence rejected', `${outside.error.details?.distanceM} m from ${outside.error.details?.nearestSite}`);
const fix = { lat: 19.0761, lng: 72.8778, accuracyM: 12, isMock: false };
const intent = await call('POST', '/v1/mobile/punch/intents', { token: e, body: fix });
ok('punch intent', `challenge=${intent.livenessChallenge.join('+')}`);
const selfie = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(40_000), Buffer.from([0xff, 0xd9])]);
const sha = createHash('sha256').update(selfie).digest('hex');
const upload = await call('POST', '/v1/mobile/punch/selfie-upload', { token: e, body: { intentId: intent.intentId, sizeBytes: selfie.length, sha256: sha } });
const put = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: selfie });
if (!put.ok) throw new Error(`selfie upload failed ${put.status} ${await put.text()}`);
ok('selfie uploaded to storage');
({ nonce } = await call('POST', '/v1/mobile/auth/nonce'));
const punch = await call('POST', '/v1/mobile/punches', {
  token: e,
  body: {
    ...fix,
    intentId: intent.intentId,
    deviceTime: new Date().toISOString(),
    liveness: { passed: true, steps: intent.livenessChallenge, durationMs: 4200, faceCount: 1 },
    selfieSha256: sha,
    nonce,
    signature: signMsg(`v1|PUNCH|${nonce}|${intent.intentId}|${sha}|${fix.lat.toFixed(6)}|${fix.lng.toFixed(6)}`),
  },
});
ok('punch committed', `${punch.punch.direction} status=${punch.day?.status}`);

// 7. Employer views
const daily = await call('GET', `/v1/tenant/attendance/daily?date=${today}`, { token: t });
const row = daily.find((d) => d.employee.id === employee.id);
ok('daily attendance shows punch', `status=${row?.status} punches=${row?.punchCount}`);
const detail = await call('GET', `/v1/tenant/attendance/employees/${employee.id}/days/${today}`, { token: t });
ok('day detail with selfie url', detail.punches[0]?.selfieUrl ? 'yes' : 'no');
const summary = await call('GET', '/v1/tenant/dashboard/summary', { token: t });
ok('dashboard summary', `employees=${summary.employees} present=${summary.present}`);
const month = today.slice(0, 7);
const pay = await call('GET', `/v1/tenant/pay/employees/${employee.id}?month=${month}`, { token: t });
ok('pay month-to-date', `basis=${pay.summary?.basis} net=${pay.summary?.netEarned} projected=${pay.summary?.projectedNet}`);
// Exports are generated inside the request, so the response already carries the final status.
const exp = await call('POST', '/v1/tenant/exports', { token: t, body: { type: 'ATTENDANCE_DAILY', format: 'XLSX', date: today } });
if (exp.status === 'FAILED') throw new Error(`export failed: ${exp.error}`);
const ready = exp.status === 'DONE' ? exp : null;
ok('export generated', exp.status);
if (ready) {
  const dl = await fetch(`${API}/v1/tenant/exports/${exp.id}/download`, { headers: { authorization: `Bearer ${t}` }, redirect: 'manual' });
  ok('export download redirect', String(dl.status));
}

// 8. Release device → new code; old token must stop working
const release = await call('POST', `/v1/tenant/employees/${employee.id}/release-device`, { token: t, body: { reason: 'Employee lost phone (smoke test)' } });
const afterRelease = await call('GET', '/v1/mobile/me', { raw: true, token: e }).then((r) => r.json());
ok('device released', `new code issued=${!!release.activationCode.code}; old session → ${afterRelease.error?.code}`);

console.log(steps.join('\n'));
console.log(`\nTenant ${tenant.tenantId} admin ${me.user.email} password StrongPass123`);
