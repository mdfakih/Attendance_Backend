import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

/** argon2id with OWASP-recommended parameters (19 MiB, t=2, p=1). */
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

@Injectable()
export class PasswordService {
  /** Real hash of a random secret, verified against when the account does not exist (equal timing). */
  private readonly dummyHash: Promise<string> = hash(randomBytes(16).toString('hex'), OPTIONS);

  hash(password: string): Promise<string> {
    return hash(password, OPTIONS);
  }

  async verify(passwordHash: string | null | undefined, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash ?? (await this.dummyHash), password);
    } catch {
      return false;
    }
  }
}
