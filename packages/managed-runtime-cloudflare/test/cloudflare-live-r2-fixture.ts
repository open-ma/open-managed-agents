export interface CloudflareR2FixturePlan {
  bucketName: string;
  ownsBucket: boolean;
}

export function resolveCloudflareR2Fixture(_input: {
  configuredBucketName?: string;
  generatedBucketName: string;
}): CloudflareR2FixturePlan {
  const configuredBucketName = _input.configuredBucketName?.trim();
  return configuredBucketName
    ? { bucketName: configuredBucketName, ownsBucket: false }
    : { bucketName: _input.generatedBucketName, ownsBucket: true };
}

export function backupObjectKeys(backupId: string): string[] {
  return [
    `backups/${backupId}/data.sqsh`,
    `backups/${backupId}/meta.json`,
  ];
}
