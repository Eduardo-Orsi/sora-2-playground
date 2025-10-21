import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

function requiredEnv(key: string) {
    const value = process.env[key];
    if (!value) {
        throw new Error(`${key} is not set`);
    }
    return value;
}

const accountId = requiredEnv('R2_ACCOUNT_ID');
const accessKeyId = requiredEnv('R2_ACCESS_KEY_ID');
const secretAccessKey = requiredEnv('R2_SECRET_ACCESS_KEY');
const bucketName = requiredEnv('R2_BUCKET_NAME');
const publicBaseUrl = requiredEnv('R2_PUBLIC_BASE_URL');

const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;

export const r2Client = new S3Client({
    region: 'auto',
    endpoint,
    credentials: {
        accessKeyId,
        secretAccessKey
    }
});

export function getBucketName() {
    return bucketName;
}

export function getPublicUrl(key: string) {
    return `${publicBaseUrl.replace(/\/$/, '')}/${key}`;
}

export async function uploadObject(key: string, body: Buffer | Uint8Array, contentType: string) {
    await r2Client.send(
        new PutObjectCommand({
            Bucket: bucketName,
            Key: key,
            Body: body,
            ContentType: contentType
        })
    );
}

export async function deleteObject(key: string) {
    await r2Client.send(
        new DeleteObjectCommand({
            Bucket: bucketName,
            Key: key
        })
    );
}
