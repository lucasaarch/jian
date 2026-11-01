import { z } from 'zod';
import { op, type XOperation } from './row.js';

export const mediaOperations: XOperation[] = [
  op(
    'x_get_media_list',
    'GET /2/media',
    'Retrieves details of Media files by their media keys.',
    'tweet.read',
    {
      query: { media_keys: z.array(z.string()) },
      preset: {
        'media.fields':
          'media_key,type,url,preview_image_url,alt_text,duration_ms,width,height,public_metrics',
      },
    },
  ),
  op(
    'x_media_analytics',
    'GET /2/media/analytics',
    'Retrieves analytics data for media.',
    'tweet.read',
    {
      query: {
        media_keys: z.array(z.string()),
        start_time: z.string(),
        end_time: z.string(),
        granularity: z.enum(['hourly', 'daily', 'total']).optional(),
      },
      preset: {
        'media_analytics.fields':
          'cta_url_clicks,cta_watch_clicks,media_key,play_from_tap,playback25,playback50,playback75,playback_complete,playback_start,timestamp,timestamped_metrics,video_views,watch_time_ms',
      },
    },
  ),
  op(
    'x_set_media_metadata',
    'POST /2/media/metadata',
    'Set metadata, such as alt text, on uploaded media.',
    'media.write',
    {
      kind: 'service',
      body: {
        id: z.string().describe('The media id the metadata is attached to.'),
        metadata: z
          .object({
            allow_download_status: z.object({ allow_download: z.boolean().optional() }).optional(),
            alt_text: z.object({ text: z.string() }).optional(),
            audience_policy: z.looseObject({}).optional(),
            content_expiration: z.object({ timestamp_sec: z.number() }).optional(),
            domain_restrictions: z.object({ whitelist: z.array(z.string()) }).optional(),
            found_media_origin: z.object({ id: z.string(), provider: z.string() }).optional(),
            geo_restrictions: z.looseObject({}).optional(),
            management_info: z.object({ managed: z.boolean() }).optional(),
            preview_image: z.object({ media_key: z.looseObject({}) }).optional(),
            sensitive_media_warning: z.looseObject({}).optional(),
            shared_info: z.object({ shared: z.boolean() }).optional(),
            sticker_info: z.object({ stickers: z.array(z.object({})) }).optional(),
            upload_source: z.object({ upload_source: z.string() }).optional(),
          })
          .describe('User-defined metadata to associate with the media.'),
      },
    },
  ),
  op(
    'x_delete_media_subtitles',
    'DELETE /2/media/subtitles',
    'Deletes subtitles for a specific Media file.',
    'media.write',
    {
      kind: 'service',
      body: {
        id: z.string().describe('The media id of the video the subtitles belong to.'),
        language_code: z.string().describe('The language code of the subtitles to delete.'),
        media_category: z.string().describe('The media category of the target media.'),
      },
    },
  ),
  op(
    'x_add_media_subtitles',
    'POST /2/media/subtitles',
    'Creates subtitles for a specific Media file.',
    'media.write',
    {
      kind: 'service',
      body: {
        id: z.string().describe('The media id of the video the subtitles belong to.'),
        media_category: z
          .enum(['AmplifyVideo', 'TweetVideo'])
          .describe('The media category of the target media.'),
        subtitles: z
          .object({
            display_name: z.string().optional().describe('Language name in a human readable form.'),
            id: z.string().optional().describe('The media id of the subtitle track.'),
            language_code: z
              .string()
              .optional()
              .describe('BCP47 language code of the subtitle track.'),
          })
          .describe('The subtitle tracks to associate with the media.'),
      },
    },
  ),
  op('x_media_status', 'GET /2/media/upload', "Read an upload's processing state.", 'media.write', {
    query: { media_id: z.string() },
    preset: { command: 'STATUS' },
  }),
  op(
    'x_get_media',
    'GET /2/media/{media_key}',
    'Retrieves details of a specific Media file by its media key.',
    'tweet.read',
    {
      preset: {
        'media.fields':
          'media_key,type,url,preview_image_url,alt_text,duration_ms,width,height,public_metrics',
      },
    },
  ),
];
