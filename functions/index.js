import { onCall } from 'firebase-functions/v2/https';

export const submitInquiry = onCall({ region: 'us-west1' }, async () => {
  return { ok: true };
});
