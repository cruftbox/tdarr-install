// Tdarr "Custom JS Function" for the HEVC project. Runs on the Straylight node.
// Rules are in tdarr.md (Requirements 5 and 6). Outputs: 1 replaced or remuxed, 2 skipped, 3 kept (not smaller).
// build-flow.ps1 embeds this file into hevc-flow.json.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CQ = 26;
const HEVC_REENCODE_BYTES = 2e9; // HEVC/AV1 files larger than this are re-encoded too
// Global tag written into every file this flow encodes. A file carrying it, or a video stream encoded by
// hevc_nvenc (files converted before the tag existed), is never encoded again.
const MARKER_TAG = 'HEVC_PROJECT';
const LOG_CSV = 'C:/Code/tdarr/logs/transcode-log.csv';
// Tdarr's own CLI runner, for progress and ETA in the web UI.
const CLI_UTILS = 'D:/Tdarr/Tdarr_Node/assets/app/plugins/FlowPlugins/FlowHelpers/1.0.0/cliUtils.js';
const MKVPROPEDIT = 'D:/Tdarr/Tdarr_Node/assets/app/mkvpropedit/win32_x64/mkvpropedit.exe';

const LANG3 = { en: 'eng', es: 'spa', fr: 'fre', de: 'ger', it: 'ita', pt: 'por', ja: 'jpn', nl: 'dut', sv: 'swe', da: 'dan', no: 'nor', fi: 'fin', ru: 'rus', zh: 'chi', ko: 'kor' };
const SUB_COPY = ['subrip', 'ass', 'ssa', 'webvtt', 'hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle'];
const HW_DECODE = ['h264', 'hevc', 'mpeg2video', 'vc1', 'av1', 'vp9'];

const csvField = (v) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const writeLog = (row) => {
  const cols = ['timestamp', 'path', 'source_codec', 'resolution', 'size_before', 'size_after', 'bytes_saved', 'cq', 'encode_seconds', 'outcome', 'reason'];
  fs.mkdirSync(path.dirname(LOG_CSV), { recursive: true });
  if (!fs.existsSync(LOG_CSV)) fs.writeFileSync(LOG_CSV, `${cols.join(',')}\n`);
  fs.appendFileSync(LOG_CSV, `${cols.map((c) => csvField(row[c])).join(',')}\n`);
};

const renameOrMove = (from, to) => {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
};

// Default tracks: the first English audio track (commentary last) is default if one exists, otherwise audio
// flags are left alone. The first full English subtitle track (forced only if no full one) is default; with
// no English subtitles, no subtitle track is default. Returns the per-type flag lists, or null if nothing changes.
const isEnglish = (s) => /^(en|eng)(-|$)/i.test((s.tags && s.tags.language) || '');
const isCommentary = (s) => /commentary/i.test((s.tags && s.tags.title) || '');
const isDefault = (s) => !!(s.disposition && s.disposition.default);
const isForced = (s) => !!(s.disposition && s.disposition.forced);
const pick = (list, prefer) => {
  const en = list.filter(isEnglish);
  return en.find((s) => prefer(s) && !isCommentary(s)) || en.find((s) => !isCommentary(s)) || en[0];
};
const planDefaults = (audio, subs) => {
  const a = pick(audio, () => true);
  const s = pick(subs, (x) => !isForced(x));
  const want = {
    audio: a ? audio.map((x) => x === a) : audio.map(isDefault),
    subtitle: subs.map((x) => x === s),
  };
  const same = want.audio.every((d, i) => d === isDefault(audio[i])) && want.subtitle.every((d, i) => d === isDefault(subs[i]));
  return same ? null : want;
};

const probe = (ffprobe, file) => JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries',
  'stream=index,codec_type:stream_disposition=default,forced:stream_tags=language,title:format=duration', '-of', 'json', file]).toString());

// Sets the default flags in an .mkv in place with mkvpropedit. Returns a short description, or '' if nothing changed.
const applyDefaults = (ffprobe, mkv, jobLog) => {
  const { streams } = probe(ffprobe, mkv);
  const audio = streams.filter((s) => s.codec_type === 'audio');
  const subs = streams.filter((s) => s.codec_type === 'subtitle');
  const want = planDefaults(audio, subs);
  if (!want) return '';
  const edits = [];
  want.audio.forEach((d, i) => edits.push('--edit', `track:a${i + 1}`, '--set', `flag-default=${d ? 1 : 0}`));
  want.subtitle.forEach((d, i) => edits.push('--edit', `track:s${i + 1}`, '--set', `flag-default=${d ? 1 : 0}`));
  jobLog(`mkvpropedit ${edits.join(' ')}`);
  execFileSync(MKVPROPEDIT, [mkv, ...edits]);
  const lang = (list, flags) => { const i = flags.indexOf(true); return i < 0 ? 'none' : ((list[i].tags && list[i].tags.language) || 'und'); };
  return `default audio ${lang(audio, want.audio)}, default subtitle ${lang(subs, want.subtitle)}`;
};

module.exports = async (args) => {
  const file = args.inputFileObj;
  const src = file._id;
  const dir = path.posix.dirname(src);
  const srcName = path.posix.basename(src);
  const base = srcName.replace(/\.[^.]+$/, '');
  const isMkv = /\.mkv$/i.test(srcName);
  const streams = file.ffProbeData.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const sizeBefore = fs.statSync(src).size;
  const ffprobe = args.ffmpegPath.replace(/ffmpeg(\.exe)?$/i, (m, ext) => `ffprobe${ext || ''}`);

  const row = {
    timestamp: new Date().toISOString(),
    path: src,
    source_codec: v ? v.codec_name : '',
    resolution: v ? `${v.width}x${v.height}` : '',
    size_before: sizeBefore,
  };
  const finish = (outputNumber, outcome, reason, extra = {}) => {
    writeLog({ ...row, outcome, reason, ...extra });
    args.jobLog(`Outcome: ${outcome}${reason ? ` (${reason})` : ''}`);
    return { outputFileObj: outputNumber === 1 ? extra.outputFileObj : file, outputNumber, variables: args.variables };
  };

  if (!v) return finish(2, 'skipped', 'no video stream');

  // Decide
  const is4K = v.width > 3000 || v.height > 1200;
  const hdr = ['smpte2084', 'arib-std-b67'].includes(v.color_transfer);
  const dovi = (v.side_data_list || []).find((d) => /DOVI/i.test(d.side_data_type || ''));
  const dv = !!dovi || ['dvh1', 'dvhe'].includes(v.codec_tag_string);
  const dvProfile = dovi ? dovi.dv_profile : undefined;

  const tagOf = (tags, name) => Object.entries(tags || {}).find(([k]) => k.toUpperCase() === name);
  const marker = tagOf(file.ffProbeData.format && file.ffProbeData.format.tags, MARKER_TAG);
  const encoder = tagOf(v.tags, 'ENCODER');

  let skipReason = '';
  if (marker) {
    skipReason = `already converted by this flow (${MARKER_TAG}=${marker[1]})`;
  } else if (encoder && /hevc_nvenc/i.test(encoder[1])) {
    skipReason = `already converted (${encoder[1]})`;
  } else if (is4K) {
    if (dv && dvProfile === 5) skipReason = 'Dolby Vision profile 5 (no HDR10 base layer)';
  } else if (['hevc', 'av1'].includes(v.codec_name) && sizeBefore <= HEVC_REENCODE_BYTES) {
    skipReason = `already ${v.codec_name}, 2 GB or smaller`;
  } else if (hdr || dv) {
    skipReason = 'HDR or Dolby Vision, not 4K';
  }

  // Whether the streams that would be kept need different default flags (sidecars not counted).
  const needsFlags = () => {
    const kept = streams.filter((s) => s.codec_type === 'audio' || (s.codec_type === 'subtitle' && (SUB_COPY.includes(s.codec_name) || s.codec_name === 'mov_text')));
    return !!planDefaults(kept.filter((s) => s.codec_type === 'audio'), kept.filter((s) => s.codec_type === 'subtitle'));
  };

  // Skipped files keep their video. An .mkv gets its default flags set in place; any other container is
  // remuxed to .mkv (video copied) only when its default flags need to change.
  if (skipReason) {
    if (isMkv) {
      const changed = applyDefaults(ffprobe, src, args.jobLog);
      return finish(2, 'skipped', changed ? `${skipReason}; ${changed}` : skipReason);
    }
    if (!needsFlags()) return finish(2, 'skipped', skipReason);
  }
  // Runs ffmpeg into the cache: an HEVC encode, or with remux a stream copy to .mkv. Returns the result
  // after verifying its duration and setting the default tracks.
  const transcode = async (remux) => {
    // Build the ffmpeg command
    const interlaced = ['tt', 'bb', 'tb', 'bt'].includes(v.field_order);
    const tenBit = is4K || /10/.test(v.pix_fmt || '');
    const ff = [];
    const outMaps = [];
    const outCodecs = [];

    if (remux) {
      // no decoding needed
    } else if (is4K) {
      ff.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda');
    } else if (HW_DECODE.includes(v.codec_name)) {
      ff.push('-hwaccel', 'cuda');
    }
    if (/\.avi$/i.test(srcName)) ff.push('-fflags', '+genpts');
    ff.push('-i', src);

    // Matching sidecars: <base>.srt, <base>.<tags>.srt, <base>.idx (with <base>.sub). Exact, case-sensitive.
    const sidecars = [];
    const subInputs = [];
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.startsWith(`${base}.`)) continue;
      const rest = name.slice(base.length + 1);
      const m = rest.match(/^(?:(.+)\.)?(srt|idx)$/i);
      if (!m) {
        if (/^sub$/i.test(rest)) sidecars.push(name);
        continue;
      }
      sidecars.push(name);
      const tags = (m[1] || '').toLowerCase().split('.');
      const lang = tags.map((t) => LANG3[t] || (/^[a-z]{3}$/.test(t) ? t : '')).find((t) => t);
      subInputs.push({ name, lang, forced: tags.includes('forced'), idx: /idx$/i.test(name) });
    }
    // .idx files can hold several tracks, so they go last; per-track indexes below only cover .srt.
    subInputs.sort((a, b) => a.idx - b.idx);
    for (const s of subInputs) ff.push('-i', `${dir}/${s.name}`);

    ff.push('-map', `0:${v.index}`);
    ff.push('-map', '0:a?');
    let subOut = 0;
    const dropped = [];
    outCodecs.push('-c:s', 'copy');
    for (const s of streams.filter((x) => x.codec_type === 'subtitle')) {
      if (SUB_COPY.includes(s.codec_name)) {
        ff.push('-map', `0:${s.index}`); subOut += 1;
      } else if (s.codec_name === 'mov_text') {
        ff.push('-map', `0:${s.index}`); outCodecs.push(`-c:s:${subOut}`, 'srt'); subOut += 1;
      } else {
        dropped.push(s.codec_name);
      }
    }
    subInputs.forEach((s, i) => {
      ff.push('-map', `${i + 1}:s`);
      if (s.idx) return;
      if (s.lang) outMaps.push(`-metadata:s:s:${subOut}`, `language=${s.lang}`);
      if (s.forced) outMaps.push(`-disposition:s:${subOut}`, 'forced');
      subOut += 1;
    });
    ff.push('-map', '0:t?');
    if (dropped.length) args.jobLog(`Dropping subtitle streams MKV cannot hold: ${dropped.join(', ')}`);

    if (remux) {
      ff.push('-c:v', 'copy');
    } else {
      if (is4K) {
        const ar = v.width / v.height;
        const w = ar >= 16 / 9 ? 1920 : Math.round((1080 * ar) / 2) * 2;
        const h = ar >= 16 / 9 ? Math.round(1920 / ar / 2) * 2 : 1080;
        ff.push('-vf', `scale_cuda=${w}:${h}:format=p010le`);
      } else if (interlaced) {
        ff.push('-vf', 'bwdif=mode=send_frame:parity=auto:deint=all');
      }
      ff.push('-c:v', 'hevc_nvenc', '-preset', 'p7', '-tune', 'hq', '-rc', 'vbr', '-cq', String(CQ), '-b:v', '0',
        '-spatial_aq', '1', '-temporal_aq', '1', '-rc-lookahead', '32', '-profile:v', tenBit ? 'main10' : 'main');
      if (tenBit && !is4K) ff.push('-pix_fmt', 'p010le');
    }
    ff.push('-c:a', 'copy', ...outCodecs, '-c:t', 'copy', ...outMaps);
    ff.push('-map_metadata', '0', '-map_chapters', '0', '-max_muxing_queue_size', '9999');
    if (!remux) ff.push('-metadata', `${MARKER_TAG}=cq${CQ}`);

    const workDir = `${args.workDir}/${Date.now()}`;
    fs.mkdirSync(workDir, { recursive: true });
    const out = `${workDir}/${base}.mkv`;
    ff.push('-y', out);

    args.jobLog(`Decision: ${remux ? `remux to .mkv for default tracks (${skipReason || 'new encode not smaller'})` : `${is4K ? '4K downscale to 1080p HEVC 10-bit' : 'HEVC'}${hdr ? ', HDR kept' : ''}${interlaced ? ', deinterlace (bwdif)' : ''}`}; sidecars: ${subInputs.map((s) => s.name).join(', ') || 'none'}`);

    // Encode (or remux)
    const { CLI } = require(CLI_UTILS);
    const t0 = Date.now();
    const cli = new CLI({
      cli: args.ffmpegPath,
      spawnArgs: ff,
      spawnOpts: {},
      jobLog: args.jobLog,
      outputFilePath: out,
      inputFileObj: file,
      logFullCliOutput: args.logFullCliOutput,
      updateWorker: args.updateWorker,
      args,
    });
    const res = await cli.runCli();
    const encodeSeconds = Math.round((Date.now() - t0) / 1000);
    if (res.cliExitCode !== 0) throw new Error(`ffmpeg failed with exit code ${res.cliExitCode}`);

    // Verify duration before touching the original
    const durOut = Number(probe(ffprobe, out).format.duration);
    const durIn = Number(file.ffProbeData.format.duration);
    if (!(durOut > 0) || (durIn > 0 && Math.abs(durOut - durIn) / durIn > 0.02)) {
      throw new Error(`Output duration ${durOut}s does not match source ${durIn}s; original left in place`);
    }
    const defaults = applyDefaults(ffprobe, out, args.jobLog);
    return { out, workDir, sidecars, encodeSeconds, defaults, sizeAfter: fs.statSync(out).size };
  };

  let remux = !!skipReason;
  let r = await transcode(remux);
  let keptNote = '';
  if (!remux && r.sizeAfter >= sizeBefore) {
    fs.unlinkSync(r.out);
    try { fs.rmdirSync(r.workDir); } catch (e) { /* not empty or already gone */ }
    const kept = { size_after: r.sizeAfter, cq: CQ, encode_seconds: r.encodeSeconds, bytes_saved: 0 };
    // The original stays. An .mkv gets English defaults in place; another container is remuxed only if its flags need to change.
    if (isMkv) {
      const changed = applyDefaults(ffprobe, src, args.jobLog);
      return finish(3, 'kept', `new file not smaller${changed ? `; ${changed}` : ''}`, kept);
    }
    if (!needsFlags()) return finish(3, 'kept', 'new file not smaller', kept);
    keptNote = `new encode not smaller (${r.sizeAfter} bytes)`;
    remux = true;
    r = await transcode(true);
  }
  const { out, workDir, sidecars, encodeSeconds, defaults, sizeAfter } = r;
  const stats = { size_after: sizeAfter, cq: remux ? '' : CQ, encode_seconds: encodeSeconds };

  // Replace: new file in as .partial, original to .old, .partial to final name, sidecars to .old
  const dest = `${dir}/${base}.mkv`;
  const partial = `${dest}.partial`;
  const old = `${src}.old`;
  if (fs.existsSync(old)) throw new Error(`${old} already exists; not overwriting it`);
  renameOrMove(out, partial);
  fs.renameSync(src, old);
  try {
    fs.renameSync(partial, dest);
  } catch (err) {
    fs.renameSync(old, src);
    throw err;
  }
  for (const name of sidecars) fs.renameSync(`${dir}/${name}`, `${dir}/${name}.old`);
  try { fs.rmdirSync(workDir); } catch (e) { /* not empty or already gone */ }

  const notes = [remux ? (keptNote || skipReason) : '', sidecars.length ? `sidecars embedded: ${sidecars.join(', ')}` : '', defaults].filter((x) => x);
  return finish(1, remux ? 'remuxed' : 'replaced', notes.join('; '), {
    ...stats, bytes_saved: sizeBefore - sizeAfter, outputFileObj: { _id: dest },
  });
};

// Also usable outside Tdarr, for fixing files that are already in the library.
Object.assign(module.exports, { planDefaults, applyDefaults, probe });
