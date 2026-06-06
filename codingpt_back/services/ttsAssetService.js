const crypto = require('crypto');
const { Op } = require('sequelize');
const {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');
const { TTSAsset, Slide, LessonSlideMap, Lesson } = require('../models');
const ttsService = require('./ttsService');
const { generateFileName } = require('./ttsFileService');
const { collectAssetIds } = require('../utils/ttsHydration');

// 공개(익명 download) 정책이 걸린 codingpt/tts/static/ 아래에 레코드별 폴더로 저장.
// objectstore 객체 키는 버킷(codingpt) 기준 상대 경로 — 'codingpt/' 를 붙이지 않는다
// (붙이면 codingpt/codingpt/... 이중 prefix 가 되어 공개 URL 과 어긋남).
// s3Service 는 키에 codingpt/ 를 강제하므로 여기선 raw S3Client 를 직접 쓴다
// (lesson-assets 업로드 스크립트와 동일한 방식).
const LIBRARY_PREFIX = 'tts/static/library';
const BUCKET = process.env.OBJECTSTORE_BUCKET || process.env.S3_BUCKET_NAME || 'codingpt';
// PUBLIC_BASE 는 이미 '/codingpt'(버킷)를 포함 → 키를 그대로 붙이면 공개 URL.
const PUBLIC_BASE = (process.env.OBJECTSTORE_PUBLIC_BASE_URL
  || `${process.env.OBJECTSTORE_ENDPOINT || 'https://objectstore.ghmate.com'}/${BUCKET}`)
  .replace(/\/+$/, '');

const s3 = new S3Client({
  region: process.env.OBJECTSTORE_REGION || process.env.AWS_REGION || 'us-east-1',
  endpoint: process.env.OBJECTSTORE_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.OBJECTSTORE_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.OBJECTSTORE_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY,
  },
});

function _err(message, statusCode) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

// 폴더 경로 정규화: 앞뒤 슬래시 제거, 중복 슬래시 정리. '' = 루트.
function _normFolder(f) {
  if (!f || typeof f !== 'string') return '';
  return f.replace(/\\+/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/').trim();
}

// settings 키 정렬 직렬화 (해시 안정성)
function _canonical(obj) {
  if (obj == null || typeof obj !== 'object') return JSON.stringify(obj ?? null);
  const keys = Object.keys(obj).sort();
  return JSON.stringify(keys.map((k) => [k, obj[k]]));
}

class TTSAssetService {
  _contentHash(text, voiceId, modelId, settings) {
    const raw = `${text || ''}|${voiceId || ''}|${modelId || ''}|${_canonical(settings)}`;
    return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
  }

  _audioKey(id) { return `${LIBRARY_PREFIX}/${id}/audio.mp3`; }
  _metaKey(id) { return `${LIBRARY_PREFIX}/${id}/meta.json`; }
  _folderPrefix(id) { return `${LIBRARY_PREFIX}/${id}/`; }

  _publicUrl(key) {
    if (!key) return null;
    return `${PUBLIC_BASE}/${key}`;
  }

  // 캐시 버스팅 버전 쿼리를 붙인 오디오 공개 URL.
  // regenerate 가 같은 키를 덮어써도 Cloudflare 가 옛 오디오를 서빙하지 않도록
  // updated_at 기반 ?v= 를 붙인다(= 매 저장마다 새 캐시 키).
  audioUrlForAsset(asset) {
    if (!asset || !asset.object_key) return null;
    const base = `${PUBLIC_BASE}/${asset.object_key}`;
    const v = asset.updated_at ? new Date(asset.updated_at).getTime() : '';
    return v ? `${base}?v=${v}` : base;
  }

  async _putObject(key, body, contentType) {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: key, Body: body, ContentType: contentType,
    }));
  }

  async _keyExists(key) {
    try { await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })); return true; }
    catch { return false; }
  }

  // 파일 기반 생성: tts/static/library/<folder>/<name>.mp3 + <name>.json(사이드카).
  // ObjectStore 브라우저로 탐색/관리하기 위해 opaque {id} 가 아닌 사람이 읽는 파일명 사용.
  async generateToFolder({ text, voiceId, modelId, folder, fileName }) {
    if (!text || !String(text).trim()) throw _err('text는 필수입니다.', 400);
    const result = await ttsService.textToSpeech(voiceId, text, modelId || 'eleven_v3', {});
    if (!result || !result.success) throw _err(`TTS 생성 실패: ${(result && result.message) || 'unknown'}`, 502);

    const folderNorm = _normFolder(folder);
    const dir = `tts/static/library${folderNorm ? '/' + folderNorm : ''}`;
    const base = String(fileName || generateFileName(text)).replace(/\.mp3$/i, '').replace(/[^가-힣a-zA-Z0-9_\-]/g, '_').slice(0, 100) || 'tts';
    let name = base;
    let n = 1;
    while (await this._keyExists(`${dir}/${name}.mp3`)) name = `${base}-${n++}`;

    const audioKey = `${dir}/${name}.mp3`;
    const metaKey = `${dir}/${name}.json`;
    await this._putObject(audioKey, result.audioBuffer, 'audio/mpeg');
    await this._putObject(metaKey, Buffer.from(JSON.stringify({
      text, voice_id: voiceId || null, model_id: modelId || 'eleven_v3',
      timestamps: result.timestamps, duration: result.duration, file_size: result.audioSize,
      created_at: new Date().toISOString(),
    }, null, 2), 'utf8'), 'application/json');

    return {
      url: this._publicUrl(audioKey),
      key: audioKey,
      fileName: `${name}.mp3`,
      folder: folderNorm,
      timestamps: result.timestamps,
      voiceId: voiceId || null,
      modelId: modelId || 'eleven_v3',
      duration: result.duration,
    };
  }

  // 오디오 버퍼를 라이브러리 파일(.mp3 + .json 사이드카)로 기록 (생성 호출 없이 저장만)
  async _writeAudioFile({ folder, fileName, text, voiceId, modelId, timestamps, duration, buffer }) {
    const folderNorm = _normFolder(folder);
    const dir = `tts/static/library${folderNorm ? '/' + folderNorm : ''}`;
    const base = String(fileName || generateFileName(text)).replace(/\.mp3$/i, '').replace(/[^가-힣a-zA-Z0-9_\-]/g, '_').slice(0, 100) || 'tts';
    let name = base; let n = 1;
    while (await this._keyExists(`${dir}/${name}.mp3`)) name = `${base}-${n++}`;
    const audioKey = `${dir}/${name}.mp3`;
    const metaKey = `${dir}/${name}.json`;
    await this._putObject(audioKey, buffer, 'audio/mpeg');
    await this._putObject(metaKey, Buffer.from(JSON.stringify({
      text, voice_id: voiceId || null, model_id: modelId || 'eleven_v3',
      timestamps, duration, file_size: buffer.length, created_at: new Date().toISOString(),
    }, null, 2), 'utf8'), 'application/json');
    return { url: this._publicUrl(audioKey), key: audioKey, fileName: `${name}.mp3`, folder: folderNorm };
  }

  // 미리듣기: 생성만 하고 저장하지 않음. 오디오를 base64 로 반환(클라가 재생, 저장 시 재사용 → 추가 호출 없음).
  async preview({ text, voiceId, modelId }) {
    if (!text || !String(text).trim()) throw _err('text는 필수입니다.', 400);
    const result = await ttsService.textToSpeech(voiceId, text, modelId || 'eleven_v3', {});
    if (!result || !result.success) throw _err(`TTS 생성 실패: ${(result && result.message) || 'unknown'}`, 502);
    return {
      audioBase64: result.audioBuffer.toString('base64'),
      timestamps: result.timestamps,
      duration: result.duration,
      voiceId: voiceId || null,
      modelId: modelId || 'eleven_v3',
      text,
    };
  }

  // 미리듣기 결과(base64)를 그대로 파일로 저장 (ElevenLabs 재호출 없음 = 추가 비용 0)
  async savePreview({ audioBase64, timestamps, duration, text, voiceId, modelId, folder, fileName }) {
    if (!audioBase64) throw _err('미리듣기 데이터가 없습니다.', 400);
    const buffer = Buffer.from(audioBase64, 'base64');
    const out = await this._writeAudioFile({ folder, fileName, text, voiceId, modelId, timestamps, duration, buffer });
    return { ...out, timestamps, voiceId: voiceId || null, modelId: modelId || 'eleven_v3', duration };
  }

  // 폴더(prefix) 전체 삭제
  async _deletePrefix(prefix) {
    let token;
    do {
      const listed = await s3.send(new ListObjectsV2Command({
        Bucket: BUCKET, Prefix: prefix, ContinuationToken: token,
      }));
      const objects = (listed.Contents || []).map((c) => ({ Key: c.Key }));
      if (objects.length > 0) {
        await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: objects } }));
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);
  }

  _meta(asset) {
    return {
      id: asset.id,
      text: asset.text,
      voice_id: asset.voice_id,
      model_id: asset.model_id,
      settings: asset.settings,
      duration: asset.duration,
      file_size: asset.file_size,
      timestamps: asset.timestamps,
      content_hash: asset.content_hash,
      name: asset.name,
      created_at: asset.created_at,
      updated_at: asset.updated_at,
    };
  }

  _serialize(asset, usage) {
    const usageList = usage || [];
    return {
      id: asset.id,
      text: asset.text,
      name: asset.name,
      voiceId: asset.voice_id,
      modelId: asset.model_id,
      settings: asset.settings,
      duration: asset.duration,
      fileSize: asset.file_size,
      timestamps: asset.timestamps,
      contentHash: asset.content_hash,
      folder: asset.folder || '',
      objectKey: asset.object_key,
      url: this.audioUrlForAsset(asset),
      createdAt: asset.created_at,
      updatedAt: asset.updated_at,
      usage: usageList,
      inUse: usageList.length > 0,
    };
  }

  // ElevenLabs 합성 → objectstore 업로드(오디오 + meta.json) → asset 컬럼 갱신
  async _synthesizeAndStore(asset, { text, voiceId, modelId, settings }) {
    const result = await ttsService.textToSpeech(voiceId, text, modelId, settings || {});
    if (!result || !result.success) {
      throw _err(`TTS 생성 실패: ${(result && result.message) || 'unknown'}`, 502);
    }
    const audioKey = this._audioKey(asset.id);
    const metaKey = this._metaKey(asset.id);

    asset.object_key = audioKey;
    asset.duration = result.duration;
    asset.file_size = result.audioSize;
    asset.timestamps = result.timestamps;
    asset.content_hash = this._contentHash(text, voiceId, modelId, settings);
    asset.name = generateFileName(text);

    await this._putObject(audioKey, result.audioBuffer, 'audio/mpeg');
    await asset.save();
    await this._putObject(metaKey, Buffer.from(JSON.stringify(this._meta(asset), null, 2), 'utf8'), 'application/json');

    return asset;
  }

  async create({ text, voiceId, modelId, settings, folder }) {
    if (!text || !String(text).trim()) throw _err('text는 필수입니다.', 400);
    const asset = await TTSAsset.create({
      text,
      voice_id: voiceId || null,
      model_id: modelId || 'eleven_v3',
      settings: settings || null,
      content_hash: this._contentHash(text, voiceId, modelId, settings),
      name: generateFileName(text),
      folder: _normFolder(folder),
    });
    try {
      await this._synthesizeAndStore(asset, { text, voiceId, modelId: modelId || 'eleven_v3', settings });
    } catch (e) {
      // 합성/업로드 실패 시 고아 레코드가 남지 않도록 롤백
      await asset.destroy().catch(() => {});
      throw e;
    }
    return this._serialize(asset, []);
  }

  async regenerate(id, patch) {
    const asset = await TTSAsset.findByPk(id);
    if (!asset) throw _err('자산을 찾을 수 없습니다.', 404);

    const next = {
      text: patch.text != null ? patch.text : asset.text,
      voiceId: patch.voiceId != null ? patch.voiceId : asset.voice_id,
      modelId: patch.modelId != null ? patch.modelId : (asset.model_id || 'eleven_v3'),
      settings: patch.settings != null ? patch.settings : asset.settings,
    };
    if (!next.text || !String(next.text).trim()) throw _err('text는 필수입니다.', 400);

    asset.text = next.text;
    asset.voice_id = next.voiceId || null;
    asset.model_id = next.modelId;
    asset.settings = next.settings || null;

    await this._synthesizeAndStore(asset, next);
    const usageMap = await this.getAssetUsageMap();
    return this._serialize(asset, usageMap[asset.id] || []);
  }

  async getById(id) {
    const asset = await TTSAsset.findByPk(id);
    if (!asset) throw _err('자산을 찾을 수 없습니다.', 404);
    const usageMap = await this.getAssetUsageMap();
    return this._serialize(asset, usageMap[asset.id] || []);
  }

  async list({ search, page = 1, limit = 20 } = {}) {
    const where = {};
    if (search && String(search).trim()) {
      where.text = { [Op.iLike]: `%${String(search).trim()}%` };
    }
    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const { rows, count } = await TTSAsset.findAndCountAll({
      where,
      order: [['id', 'DESC']],
      offset: (p - 1) * l,
      limit: l,
    });
    const usageMap = await this.getAssetUsageMap();
    const data = rows.map((a) => this._serialize(a, usageMap[a.id] || []));
    return { data, page: p, limit: l, total: count };
  }

  async remove(id, { force = false } = {}) {
    const asset = await TTSAsset.findByPk(id);
    if (!asset) throw _err('자산을 찾을 수 없습니다.', 404);
    const usageMap = await this.getAssetUsageMap();
    const usage = usageMap[asset.id] || [];
    if (usage.length > 0 && !force) {
      const e = _err(`이 자산은 ${usage.length}개 위치에서 사용 중입니다. 강제 삭제하려면 force=1 을 전달하세요.`, 409);
      e.usage = usage;
      throw e;
    }
    // objectstore 폴더(오디오 + meta.json) 삭제
    await this._deletePrefix(this._folderPrefix(asset.id));
    await asset.destroy();
    return { id: Number(id), deleted: true, forced: !!force, usage };
  }

  // 자산 사용처 맵: { [assetId]: [{ lessonId, lessonName, slideId, slideTitle, orderNo }] }
  // slide.contents 전수 스캔 + tts.assetId 수집 (lessonEditorService.getUsedAssetMap 패턴).
  async getAssetUsageMap() {
    const slides = await Slide.findAll({
      attributes: ['id', 'contents'],
      include: [{
        model: LessonSlideMap,
        attributes: ['lesson_id', 'order_no'],
        include: [{ model: Lesson, attributes: ['id', 'name'] }],
      }],
    });
    const map = {};
    for (const s of slides) {
      const ids = collectAssetIds(s.contents);
      if (ids.size === 0) continue;
      const slideTitle = (s.contents && typeof s.contents === 'object' && s.contents.title)
        ? String(s.contents.title) : '';
      const maps = s.LessonSlideMaps || [];
      for (const id of ids) {
        if (!map[id]) map[id] = [];
        if (maps.length === 0) {
          map[id].push({ lessonId: null, lessonName: '(연결된 레슨 없음)', slideId: s.id, slideTitle, orderNo: null });
        }
        for (const m of maps) {
          const lesson = m.Lesson;
          if (!lesson) continue;
          map[id].push({
            lessonId: lesson.id,
            lessonName: lesson.name,
            slideId: s.id,
            slideTitle,
            orderNo: m.order_no,
          });
        }
      }
    }
    return map;
  }
}

module.exports = new TTSAssetService();
