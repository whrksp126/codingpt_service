#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');

const PREFIX = 'db-backups/';

function getClient() {
  const required = ['OBJECTSTORE_ENDPOINT', 'OBJECTSTORE_ACCESS_KEY', 'OBJECTSTORE_SECRET_KEY'];
  for (const k of required) {
    if (!process.env[k]) {
      console.error(`ERROR: ${k} 환경 변수가 필요합니다. (set -a && source .env.local && set +a)`);
      process.exit(1);
    }
  }
  return new S3Client({
    endpoint: process.env.OBJECTSTORE_ENDPOINT,
    region: process.env.OBJECTSTORE_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.OBJECTSTORE_ACCESS_KEY,
      secretAccessKey: process.env.OBJECTSTORE_SECRET_KEY,
    },
    forcePathStyle: true,
  });
}

function getBucket() {
  return process.env.OBJECTSTORE_BACKUP_BUCKET || process.env.OBJECTSTORE_BUCKET;
}

async function upload(localPath) {
  const fileName = path.basename(localPath);
  const key = PREFIX + fileName;
  const Body = fs.readFileSync(localPath);
  const s3 = getClient();
  await s3.send(new PutObjectCommand({
    Bucket: getBucket(),
    Key: key,
    Body,
    ContentType: 'application/sql',
  }));
  const size = (Body.length / 1024 / 1024).toFixed(2);
  console.log(`>>> 업로드 완료: s3://${getBucket()}/${key} (${size} MB)`);
}

async function download(fileName, outDir) {
  const key = PREFIX + fileName;
  const s3 = getClient();
  const res = await s3.send(new GetObjectCommand({ Bucket: getBucket(), Key: key }));
  const outPath = path.join(outDir, fileName);
  fs.mkdirSync(outDir, { recursive: true });
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(outPath);
    res.Body.pipe(ws);
    res.Body.on('error', reject);
    ws.on('finish', resolve);
    ws.on('error', reject);
  });
  console.log(`>>> 다운로드 완료: ${outPath}`);
  console.log(outPath);
}

async function list() {
  const s3 = getClient();
  const res = await s3.send(new ListObjectsV2Command({
    Bucket: getBucket(),
    Prefix: PREFIX,
  }));
  const items = (res.Contents || [])
    .filter((o) => o.Key !== PREFIX)
    .sort((a, b) => (a.Key < b.Key ? 1 : -1));
  if (items.length === 0) {
    console.log('(백업 없음)');
    return;
  }
  console.log('백업 파일 목록 (최신순):');
  for (const o of items) {
    const name = o.Key.replace(PREFIX, '');
    const mb = (o.Size / 1024 / 1024).toFixed(2);
    const ts = new Date(o.LastModified).toISOString().replace('T', ' ').slice(0, 19);
    console.log(`  ${name}\t${mb} MB\t${ts} UTC`);
  }
}

async function latest() {
  const s3 = getClient();
  const res = await s3.send(new ListObjectsV2Command({
    Bucket: getBucket(),
    Prefix: PREFIX,
  }));
  const items = (res.Contents || [])
    .filter((o) => o.Key !== PREFIX && o.Key.endsWith('.sql'))
    .sort((a, b) => (a.Key < b.Key ? 1 : -1));
  if (items.length === 0) {
    console.error('ERROR: objectstore에 백업 파일이 없습니다.');
    process.exit(1);
  }
  const name = items[0].Key.replace(PREFIX, '');
  console.log(name);
}

(async () => {
  const [cmd, arg1, arg2] = process.argv.slice(2);
  try {
    if (cmd === 'upload') {
      if (!arg1) throw new Error('사용법: upload <local-path>');
      await upload(arg1);
    } else if (cmd === 'download') {
      if (!arg1 || !arg2) throw new Error('사용법: download <filename> <out-dir>');
      await download(arg1, arg2);
    } else if (cmd === 'list') {
      await list();
    } else if (cmd === 'latest') {
      await latest();
    } else {
      console.error('사용법: _db-backup-s3.js <upload|download|list|latest> [...args]');
      process.exit(1);
    }
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exit(1);
  }
})();
