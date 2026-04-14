import { Firestore } from '@google-cloud/firestore';

export function getFirestore(config) {
  return new Firestore({ projectId: config.GOOGLE_CLOUD_PROJECT });
}
