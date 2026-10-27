import { Inject, Injectable } from '@nestjs/common';
import type { AuthRealm, PlatformRole } from '@attendance/contracts';
import { errors, jwtVerify, SignJWT } from 'jose';
import { ENV, type Env } from '../config/env.js';
import { AppError } from '../http/app-error.js';

export interface EmployeeClaims {
  readonly sub: string;
  readonly tid: string;
  readonly bid: string;
}

export interface TenantUserClaims {
  readonly sub: string;
  readonly uid: string;
  readonly tid: string;
  readonly pv: number;
}

export interface PlatformClaims {
  readonly sub: string;
  readonly role: PlatformRole;
}

interface ClaimsByRealm {
  EMPLOYEE: EmployeeClaims;
  TENANT_USER: TenantUserClaims;
  PLATFORM_USER: PlatformClaims;
}

export interface SignedToken {
  readonly token: string;
  readonly expiresAt: Date;
}

const AUDIENCE: Readonly<Record<AuthRealm, string>> = {
  EMPLOYEE: 'emp',
  TENANT_USER: 'tenant',
  PLATFORM_USER: 'platform',
};

const TTL_SECONDS: Readonly<Record<AuthRealm, number>> = {
  EMPLOYEE: 15 * 60,
  TENANT_USER: 15 * 60,
  PLATFORM_USER: 10 * 60,
};

const ISSUER = 'attendance-api';

/** Short-lived HS256 access tokens, one secret and audience per realm. */
@Injectable()
export class TokenService {
  private readonly secrets: Readonly<Record<AuthRealm, Uint8Array>>;

  constructor(@Inject(ENV) env: Env) {
    const enc = new TextEncoder();
    this.secrets = {
      EMPLOYEE: enc.encode(env.JWT_SECRET_EMPLOYEE),
      TENANT_USER: enc.encode(env.JWT_SECRET_TENANT),
      PLATFORM_USER: enc.encode(env.JWT_SECRET_PLATFORM),
    };
  }

  async sign<R extends AuthRealm>(realm: R, claims: ClaimsByRealm[R]): Promise<SignedToken> {
    const { sub, ...rest } = claims as ClaimsByRealm[R] & { sub: string };
    const expiresAt = new Date(Date.now() + TTL_SECONDS[realm] * 1000);
    const token = await new SignJWT(rest as Record<string, unknown>)
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE[realm])
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(this.secrets[realm]);
    return { token, expiresAt };
  }

  async verify<R extends AuthRealm>(realm: R, token: string): Promise<ClaimsByRealm[R]> {
    try {
      const { payload } = await jwtVerify(token, this.secrets[realm], { issuer: ISSUER, audience: AUDIENCE[realm] });
      return { ...payload, sub: payload.sub } as unknown as ClaimsByRealm[R];
    } catch (error: unknown) {
      if (error instanceof errors.JWTExpired) {
        throw new AppError('TOKEN_EXPIRED');
      }
      throw new AppError('UNAUTHENTICATED');
    }
  }
}
