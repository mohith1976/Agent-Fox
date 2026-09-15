import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadBucketCommand,
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
