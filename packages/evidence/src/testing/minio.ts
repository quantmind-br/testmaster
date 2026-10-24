import * as childProcess from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  CreateBucketCommand,
  PutObjectLockConfigurationCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const exec = (file: string, args: string[]) => promisify(childProcess.execFile)(file, args);

/**
 * The S3-compatible server evidence tests run against: an unmodified mirror of minio/minio
 * RELEASE.2025-09-07T16-13-09Z, whose Docker Hub repository is gone. The digest keeps a different
 * build from being used silently.
 */
export const minioTestImage =
  "ghcr.io/quantmind-br/minio@sha256:a1a8bd4ac40ad7881a245bab97323e18f971e4d4cba2c2007ec1bedd21cbaba2";

export interface MinioTestServer {
  /** `http://127.0.0.1:<port>`; the container binds loopback only. */
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Creates a bucket; `objectLock` makes it an Object Lock bucket with that default retention. */
  createBucket(
    name: string,
    options?: { objectLock?: { mode: "COMPLIANCE" | "GOVERNANCE"; days: number } },
  ): Promise<void>;
  /**
   * Creates an IAM user limited by `policy` (an IAM policy document), through the `mc` binary the
   * image ships. The root credential stays the only one that can create buckets and users.
   */
  createUser(accessKeyId: string, secretAccessKey: string, policy: object): Promise<void>;
  stop(): Promise<void>;
}

async function waitLive(endpoint: string): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      if ((await fetch(`${endpoint}/minio/health/live`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await delay(200);
  }
  throw new Error("The MinIO test server did not become live within 30 s");
}

/**
 * Starts the pinned MinIO image on a random loopback port. It fails closed: with Docker or the
 * image missing it throws and says what to restore, never falling back to another server or tag.
 */
export async function startMinioTestServer(): Promise<MinioTestServer> {
  try {
    await exec("docker", ["image", "inspect", minioTestImage]);
  } catch (error) {
    throw new Error(
      `MinIO test image ${minioTestImage} is not available to Docker (${error instanceof Error ? error.message.split("\n")[0] : error}); pull it with docker pull ${minioTestImage}`,
    );
  }
  const name = `tm-minio-test-${process.pid}-${Date.now().toString(36)}`;
  const accessKeyId = `tm${randomBytes(6).toString("hex")}`;
  const secretAccessKey = randomBytes(18).toString("base64url");
  await exec("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "--label",
    "io.testmaster.test=minio",
    "-e",
    `MINIO_ROOT_USER=${accessKeyId}`,
    "-e",
    `MINIO_ROOT_PASSWORD=${secretAccessKey}`,
    "-p",
    "127.0.0.1::9000",
    minioTestImage,
    "server",
    "/data",
  ]);
  const stop = async (): Promise<void> => {
    await exec("docker", ["rm", "-f", name]).catch(() => undefined);
  };
  try {
    const mapping =
      (await exec("docker", ["port", name, "9000/tcp"])).stdout.trim().split("\n")[0] ?? "";
    const match = /^127\.0\.0\.1:(\d+)$/u.exec(mapping);
    if (!match) throw new Error(`MinIO test server must bind loopback only, got ${mapping}`);
    const endpoint = `http://127.0.0.1:${match[1]}`;
    await waitLive(endpoint);
    const admin = new S3Client({
      endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });
    return {
      endpoint,
      accessKeyId,
      secretAccessKey,
      async createBucket(bucket, options = {}) {
        await admin.send(
          new CreateBucketCommand({
            Bucket: bucket,
            ...(options.objectLock ? { ObjectLockEnabledForBucket: true } : {}),
          }),
        );
        if (options.objectLock)
          await admin.send(
            new PutObjectLockConfigurationCommand({
              Bucket: bucket,
              ObjectLockConfiguration: {
                ObjectLockEnabled: "Enabled",
                Rule: {
                  DefaultRetention: {
                    Mode: options.objectLock.mode,
                    Days: options.objectLock.days,
                  },
                },
              },
            }),
          );
      },
      async createUser(userAccessKeyId, userSecretAccessKey, policy) {
        const policyName = `p-${userAccessKeyId}`;
        const file = `/tmp/${policyName}.json`;
        const run = (command: string) => exec("docker", ["exec", name, "sh", "-c", command]);
        await run(
          `mc alias set local http://127.0.0.1:9000 ${accessKeyId} ${secretAccessKey} && printf %s '${JSON.stringify(policy)}' > ${file} && mc admin policy create local ${policyName} ${file} && mc admin user add local ${userAccessKeyId} ${userSecretAccessKey} && mc admin policy attach local ${policyName} --user ${userAccessKeyId}`,
        );
      },
      async stop() {
        admin.destroy();
        await stop();
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
