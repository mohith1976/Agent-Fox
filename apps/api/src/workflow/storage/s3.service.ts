import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';

/**
 * S3 Service for workbook storage operations
 * Supports both LocalStack (development) and AWS S3 (production)
 */
@Injectable()
export class S3Service {
  private readonly logger = new Logger(S3Service.name);
  private readonly s3Client: S3Client;
  private readonly bucket: string;
  private readonly workbookKey: string;

  constructor(private readonly configService: ConfigService) {
    const endpoint = this.configService.get<string>('AWS_S3_ENDPOINT');
    const region = this.configService.get<string>('AWS_S3_REGION', 'ap-south-1');
    this.bucket =
      this.configService.get<string>('AWS_S3_BUCKET') ?? 'agent-fox-budget';
    this.workbookKey =
      this.configService.get<string>('AWS_S3_WORKBOOK_KEY') ??
      'Budget_2026.xlsx';

    this.s3Client = new S3Client({
      endpoint,
      region,
      forcePathStyle: true, // Required for LocalStack
      credentials: {
        accessKeyId:
          this.configService.get<string>('AWS_ACCESS_KEY_ID') ?? 'test',
        secretAccessKey:
          this.configService.get<string>('AWS_SECRET_ACCESS_KEY') ?? 'test',
      },
    });

    this.logger.log(
      `S3Service initialized - Bucket: ${this.bucket}, Key: ${this.workbookKey}, Endpoint: ${endpoint || 'AWS'}`,
    );
  }

  /**
   * Download the workbook from S3
   * @param keyOverride - Optional key override (for testing)
   * @returns Buffer containing the workbook data
   * @throws Error if download fails
   */
  async downloadWorkbook(keyOverride?: string): Promise<Buffer> {
    const key = keyOverride ?? this.workbookKey;
    try {
      this.logger.log(`Downloading workbook: ${this.bucket}/${key}`);

      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const response = await this.s3Client.send(command);

      if (!response.Body) {
        throw new Error('S3 GetObject returned empty body');
      }

      // Convert stream to buffer
      const chunks: Uint8Array[] = [];
      // @ts-expect-error - AWS SDK stream types
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }

      const buffer = Buffer.concat(chunks);
      this.logger.log(`Workbook downloaded successfully (${buffer.length} bytes)`);

      return buffer;
    } catch (error) {
      this.logger.error(
        `Failed to download workbook from S3: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new Error(
        `S3 download failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Upload the workbook to S3
   * @param buffer - Buffer containing the workbook data
   * @param keyOverride - Optional key override (for testing)
   * @throws Error if upload fails
   */
  async uploadWorkbook(buffer: Buffer, keyOverride?: string): Promise<void> {
    const key = keyOverride ?? this.workbookKey;
    try {
      this.logger.log(
        `Uploading workbook: ${this.bucket}/${key} (${buffer.length} bytes)`,
      );

      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });

      await this.s3Client.send(command);

      this.logger.log('Workbook uploaded successfully');
    } catch (error) {
      this.logger.error(
        `Failed to upload workbook to S3: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new Error(
        `S3 upload failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The configured key (current book) as-is, for fallback decisions. */
  get defaultKey(): string {
    return this.workbookKey;
  }

  /**
   * Workbook key for a calendar year. The configured key stays the DEFAULT
   * (current book) — a year is substituted only when it differs, so all
   * current-year flows resolve to the exact same key as before (zero
   * behavior change for the live book).
   */
  workbookKeyFor(year: number): string {
    const base = this.workbookKey;
    const match = base.match(/^(.*)(\d{4})(\.[^.]+)$/);
    if (!match) {
      return base;
    }
    if (Number(match[2]) === year) {
      return base;
    }
    return `${match[1]}${year}${match[3]}`;
  }

  /**
   * Year of a workbook key (parsed from a 4-digit year in the name), or null
   * when the key carries none (treated as the default/current book).
   */
  yearOfKey(key: string): number | null {
    const match = key.match(/(\d{4})/);
    return match ? Number(match[1]) : null;
  }

  /**
   * All yearly workbook keys present in the bucket (Budget_2026.xlsx,
   * Budget_2027.xlsx, …), sorted ascending. Non-year keys are ignored.
   */
  async listWorkbookKeys(): Promise<string[]> {
    const response = await this.s3Client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: 'Budget_',
      }),
    );
    const keys = (response.Contents || [])
      .map((o) => o.Key || '')
      .filter((k) => k.endsWith('.xlsx') && this.yearOfKey(k) !== null)
      .sort();
    return keys;
  }

  /**
   * Download the workbook WITH its S3 version (ETag).
   * The ETag is captured BEFORE any mutation and used as the IfMatch
   * precondition for the conditional upload (compare-and-swap).
   */
  async downloadWithMetadata(keyOverride?: string): Promise<{
    buffer: Buffer;
    etag: string;
  }> {
    const key = keyOverride ?? this.workbookKey;
    const buffer = await this.downloadWorkbook(keyOverride);

    const head = await this.s3Client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
    );

    if (!head.ETag) {
      throw new Error('S3 HeadObject returned no ETag');
    }

    return { buffer, etag: head.ETag };
  }

  /**
   * Conditional upload: succeeds ONLY if the S3 object still has the
   * expected ETag (i.e. nobody modified the workbook since we downloaded it).
   * This is the atomic compare-and-swap that prevents lost updates from
   * concurrent writers on different threads.
   *
   * NOTE: IfMatch enforcement verified against the pinned dev setup
   * (LocalStack 2026.x returns 412 PreconditionFailed on ETag mismatch).
   * AWS S3 enforces it identically.
   *
   * Thrown errors carry a `code` property:
   *  - 'PreconditionFailed' (412): stale base version, DO NOT retry blindly
   *  - 'ConditionalRequestConflict' (409): concurrent conflicting write
   *  - 'S3_UPLOAD_TIMEOUT': unknown commit state, MUST verify via ETag first
   */
  async uploadConditional(
    buffer: Buffer,
    options: { ifMatch: string },
    keyOverride?: string,
  ): Promise<void> {
    const key = keyOverride ?? this.workbookKey;

    this.logger.log(
      `Conditional upload: ${this.bucket}/${key} (${buffer.length} bytes, IfMatch=${options.ifMatch})`,
    );

    try {
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: buffer,
          ContentType:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          IfMatch: options.ifMatch,
        }),
      );

      this.logger.log('Conditional upload succeeded');
    } catch (error) {
      throw this.classifyUploadError(error);
    }
  }

  /**
   * Current ETag of the workbook (for post-timeout commit verification).
   * Returns null when the object is missing or unreadable.
   */
  async headETag(keyOverride?: string): Promise<string | null> {
    const key = keyOverride ?? this.workbookKey;

    try {
      const head = await this.s3Client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return head.ETag ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Map raw AWS SDK errors to the financial-safety error contract.
   */
  private classifyUploadError(error: unknown): Error {
    const err = error as {
      name?: string;
      message?: string;
      code?: string;
      $metadata?: { httpStatusCode?: number };
    };
    const status = err.$metadata?.httpStatusCode;
    const coded = new Error(
      `S3 upload failed: ${err.message || err.name || String(error)}`,
    ) as Error & { code?: string };

    if (
      err.name === 'PreconditionFailed' ||
      err.code === 'PreconditionFailed' ||
      status === 412
    ) {
      coded.code = 'PreconditionFailed';
      coded.message = `PreconditionFailed: workbook modified concurrently — ${coded.message}`;
      return coded;
    }

    if (
      err.name === 'ConditionalRequestConflict' ||
      err.code === 'ConditionalRequestConflict' ||
      status === 409
    ) {
      coded.code = 'ConditionalRequestConflict';
      coded.message = `ConditionalRequestConflict: concurrent conflicting write — ${coded.message}`;
      return coded;
    }

    const message = `${err.name || ''} ${err.code || ''} ${err.message || ''}`.toLowerCase();
    if (
      err.name === 'TimeoutError' ||
      err.code === 'TimeoutError' ||
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('etimedout') ||
      message.includes('econnreset') ||
      message.includes('socket hang up')
    ) {
      coded.code = 'S3_UPLOAD_TIMEOUT';
      coded.message = `S3_UPLOAD_TIMEOUT: unknown commit state — ${coded.message}`;
      return coded;
    }

    return coded;
  }

  /**
   * Check if the S3 bucket is accessible
   * @returns true if bucket is accessible, false otherwise
   */
  async checkBucketAccess(): Promise<boolean> {
    try {
      const command = new HeadBucketCommand({
        Bucket: this.bucket,
      });

      await this.s3Client.send(command);
      return true;
    } catch (error) {
      this.logger.error(
        `Bucket access check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}
