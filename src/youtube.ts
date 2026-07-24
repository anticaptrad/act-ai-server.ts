// YouTube Data API publishing.
//
// Uses a long-lived OAuth2 refresh token for headless, background auth. All
// credentials come from the environment (injected by the k8s deployment).
import { google } from 'googleapis';
import fs from 'fs';

const oauth2Client = new google.auth.OAuth2(
  process.env.YOUTUBE_CLIENT_ID,
  process.env.YOUTUBE_CLIENT_SECRET,
  process.env.YOUTUBE_REDIRECT_URI,
);

oauth2Client.setCredentials({
  refresh_token: process.env.YOUTUBE_REFRESH_TOKEN,
});

const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

/** Upload a local video file to YouTube and return the created video id. */
export async function uploadToYouTube(
  filePath: string,
  title: string,
  description: string,
): Promise<string> {
  const fileSize = fs.statSync(filePath).size;

  const res = await youtube.videos.insert(
    {
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title,
          description,
          tags: ['AI', 'Automation', 'Generated'],
          categoryId: '28', // Science & Technology
        },
        status: {
          privacyStatus: process.env.YOUTUBE_PRIVACY_STATUS ?? 'private',
          selfDeclaredMadeForKids: false,
        },
      },
      media: {
        body: fs.createReadStream(filePath),
      },
    },
    {
      onUploadProgress: (evt) => {
        const progress = Math.round((evt.bytesRead / fileSize) * 100);
        console.log('YouTube upload progress', { progress: `${progress}%` });
      },
    },
  );

  const videoId = res.data.id;
  if (!videoId) {
    throw new Error('YouTube upload did not return a video id');
  }
  return videoId;
}
