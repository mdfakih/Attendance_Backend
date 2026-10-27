import { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';

export interface PresignedUpload {
  readonly url: string;
  readonly method: 'PUT';
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: string;
}

export interface ObjectInfo {
  readonly sizeBytes: number;
  readonly contentType: string | undefined;
}

function s3Client(env: Env, endpoint: string | undefined): S3Client {
  return new S3Client({
    region: env.S3_REGION,
    endpoint,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
    // Third-party S3 stores reject the SDK's default flexible checksums on presigned URLs.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

/** Private object storage. Clients only ever get short-lived presigned URLs. */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  private readonly signer: S3Client;
  readonly bucket: string;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.client = s3Client(env, env.S3_ENDPOINT);
    this.signer = s3Client(env, env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT);
    this.bucket = env.S3_BUCKET;
  }

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === 'production') {
      return;
    }
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        this.logger.log(`Created bucket ${this.bucket}`);
      } catch (error: unknown) {
        this.logger.warn(`Could not ensure bucket ${this.bucket}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** PUT URL bound to the exact content type and length. */
  async presignPut(key: string, contentType: string, contentLength: number, expiresInSec = 120): Promise<PresignedUpload> {
    const command = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ContentLength: contentLength });
    const url = await getSignedUrl(this.signer, command, {
      expiresIn: expiresInSec,
      signableHeaders: new Set(['content-type', 'content-length']),
    });
    return {
      url,
      method: 'PUT',
      headers: { 'Content-Type': contentType, 'Content-Length': String(contentLength) },
      expiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
    };
  }

  async presignGet(key: string, expiresInSec = 300, downloadName?: string): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: downloadName ? `attachment; filename="${downloadName.replace(/"/g, '')}"` : undefined,
    });
    return getSignedUrl(this.signer, command, { expiresIn: expiresInSec });
  }

  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { sizeBytes: Number(out.ContentLength ?? 0), contentType: out.ContentType };
    } catch {
      return null;
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async getBuffer(key: string): Promise<Buffer> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const body = out.Body;
    if (!(body instanceof Readable)) {
      throw new Error(`Unexpected body for ${key}`);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks);
  }

  async deleteMany(keys: readonly string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      if (batch.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }),
        );
      }
    }
  }
}
