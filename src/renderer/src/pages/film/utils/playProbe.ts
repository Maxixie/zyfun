import { PROXY_API } from '@shared/config/env';
import { convertWebToElectron } from '@shared/modules/headers';
import { isArray, isHttp, isObject, isObjectEmpty, isString } from '@shared/modules/validate';
import type { ICmsInfoEpisode, ICmsPlay } from '@shared/types/cms';

import { fetchCmsDetail, fetchCmsPlay } from '@/api/film';
import { mediaUtils } from '@/components/multi-player/src/utils/tool';
import { t } from '@/locales';
import { normalRequest } from '@/utils/request';

/**
 * Probe status of a search result
 * - pending: not probed yet
 * - ok: first episode stream reachable
 * - unknown: needs parse/sniff/proxy, can not be verified ahead of time
 * - fail: no episode, no play url or stream unreachable
 */
export type IProbeStatus = 'pending' | 'ok' | 'unknown' | 'fail';

export interface IProbeResult {
  status: IProbeStatus;
  height: number;
}

const PROBE_TIMEOUT = 8000;

const pickPlayUrl = (url: ICmsPlay['url']): string => {
  if (isString(url)) return url;
  if (isArray(url)) return (url as string[]).find((item) => isHttp(item)) || '';
  return '';
};

/**
 * Guess the vertical resolution from text such as "4K", "1080P", "超清"
 */
export const heightFromText = (text: string = ''): number => {
  const str = text.toUpperCase();
  if (/(4K|2160P|UHD)/.test(str)) return 2160;
  if (/(2K|1440P)/.test(str)) return 1440;
  const match = str.match(/(\d{3,4})P/);
  if (match) return Number(match[1]);
  if (/(蓝光|FHD)/.test(str)) return 1080;
  return 0;
};

/**
 * Get the max vertical resolution declared in an HLS master playlist
 */
export const heightFromMaster = (text: string): number => {
  let height = 0;
  for (const match of text.matchAll(/RESOLUTION=\d+x(\d+)/gi)) {
    height = Math.max(height, Number(match[1]));
  }
  return height;
};

/**
 * First uri line (non comment) of a playlist, resolved against the playlist url
 */
const firstUri = (text: string, base: string): string => {
  const line = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith('#'));
  if (!line) return '';
  try {
    return new URL(line, base).href;
  } catch {
    return '';
  }
};

/**
 * Pick the variant with the highest resolution from a master playlist
 */
const bestVariantUri = (text: string, base: string): string => {
  const lines = text.split(/\r?\n/).map((item) => item.trim());
  let best = { height: -1, uri: '' };
  lines.forEach((line, index) => {
    if (!line.startsWith('#EXT-X-STREAM-INF')) return;
    const uri = lines.slice(index + 1).find((item) => item && !item.startsWith('#'));
    if (!uri) return;
    const height = Number(line.match(/RESOLUTION=\d+x(\d+)/i)?.[1] || 0);
    if (height > best.height) best = { height, uri };
  });
  if (!best.uri) return firstUri(text, base);
  try {
    return new URL(best.uri, base).href;
  } catch {
    return '';
  }
};

const getText = async (url: string, headers: Record<string, any>, signal: AbortSignal): Promise<string> => {
  const resp = await normalRequest.request(
    {
      url,
      method: 'GET',
      responseType: 'text',
      timeout: PROBE_TIMEOUT,
      headers: { ...convertWebToElectron(headers), Accept: '*/*' },
      signal,
    },
    { joinTime: false, isReturnNativeResponse: true },
  );
  if (resp.status !== 200 && resp.status !== 206) throw new Error(`HTTP ${resp.status}`);
  return isString(resp.data) ? resp.data : '';
};

const isReachable = async (url: string, headers: Record<string, any>, signal: AbortSignal): Promise<boolean> => {
  try {
    const resp = await normalRequest.request(
      {
        url,
        method: 'GET',
        responseType: 'arraybuffer',
        timeout: PROBE_TIMEOUT,
        headers: { ...convertWebToElectron(headers), Range: 'bytes=0-1023', Accept: '*/*' },
        signal,
      },
      { joinTime: false, isReturnNativeResponse: true },
    );
    return resp.status === 200 || resp.status === 206;
  } catch {
    return false;
  }
};

/**
 * Check an HLS playlist: follow master -> best variant -> first segment
 */
const probeHls = async (
  url: string,
  headers: Record<string, any>,
  signal: AbortSignal,
  text?: string,
): Promise<IProbeResult> => {
  let body = text ?? (await getText(url, headers, signal));
  if (!body.includes('#EXTM3U')) return { status: 'fail', height: 0 };

  let height = 0;
  let playlistUrl = url;

  if (body.includes('#EXT-X-STREAM-INF')) {
    height = heightFromMaster(body);
    playlistUrl = bestVariantUri(body, url);
    if (!playlistUrl) return { status: 'fail', height: 0 };
    body = await getText(playlistUrl, headers, signal);
    if (!body.includes('#EXTM3U')) return { status: 'fail', height: 0 };
  }

  const segment = firstUri(body, playlistUrl);
  if (!segment) return { status: 'fail', height: 0 };

  const ok = await isReachable(segment, headers, signal);
  return ok ? { status: 'ok', height } : { status: 'fail', height: 0 };
};

/**
 * Probe one search result: detail -> first episode -> play url -> stream
 */
export const probePlayable = async (
  siteId: string,
  vodId: string,
  hint: string,
  signal: AbortSignal,
): Promise<IProbeResult> => {
  try {
    const detail = await fetchCmsDetail({ uuid: siteId, ids: vodId, signal });
    const episodes = detail?.list?.[0]?.vod_episode as Record<string, ICmsInfoEpisode[]> | undefined;
    if (!isObject(episodes) || isObjectEmpty(episodes)) return { status: 'fail', height: 0 };

    const flag = Object.keys(episodes).find((key) => isArray(episodes[key]) && episodes[key].length > 0);
    if (!flag) return { status: 'fail', height: 0 };
    const episode = episodes[flag][0];

    const play: ICmsPlay = await fetchCmsPlay({ uuid: siteId, flag, play: episode.link, signal });
    const url = pickPlayUrl(play?.url);
    const textHeight = heightFromText(`${hint} ${flag} ${episode.text}`);

    if (play?.jx === 1 || play?.parse === 1) return { status: 'unknown', height: textHeight };
    if (!url) return { status: 'fail', height: 0 };
    if (url.startsWith(PROXY_API)) return { status: 'unknown', height: textHeight };

    const headers = play.headers || {};
    const mediaType = await mediaUtils.checkMediaType(url, headers);

    let result: IProbeResult;
    if (mediaType === 'm3u8') {
      result = await probeHls(url, headers, signal);
    } else if (mediaType !== 'unknown') {
      const ok = await isReachable(url, headers, signal);
      result = { status: ok ? 'ok' : 'fail', height: 0 };
    } else {
      // Some servers return HLS with a generic content type
      const text = await getText(url, headers, signal);
      result = await probeHls(url, headers, signal, text);
    }

    if (result.status === 'ok' && !result.height) result.height = textHeight;
    return result;
  } catch {
    return { status: signal.aborted ? 'pending' : 'fail', height: 0 };
  }
};

/**
 * Sort weight: playable first (higher resolution first), then pending/unknown, then failed
 */
export const probeRank = (result?: IProbeResult): number => {
  if (!result || result.status === 'pending' || result.status === 'unknown') return 1;
  if (result.status === 'ok') return 0;
  return 2;
};

/**
 * Short badge text for a probe result
 */
export const probeLabel = (
  result?: IProbeResult,
): { text: string; theme: 'success' | 'warning' | 'danger' | 'default' } => {
  if (!result || result.status === 'pending') return { text: t('pages.film.probe.pending'), theme: 'default' };
  if (result.status === 'fail') return { text: t('pages.film.probe.fail'), theme: 'danger' };
  if (result.status === 'unknown') return { text: t('pages.film.probe.unknown'), theme: 'warning' };
  const { height } = result;
  if (height >= 2160) return { text: '4K', theme: 'success' };
  if (height >= 1440) return { text: '2K', theme: 'success' };
  if (height > 0) return { text: `${height}P`, theme: 'success' };
  return { text: t('pages.film.probe.ok'), theme: 'success' };
};
