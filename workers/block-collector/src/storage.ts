// ============================================
// R2 Storage Helpers for Block Collection
// ============================================

export interface StoragePaths {
  blocks: {
    screenshot: (siteId: string, blockId: string) => string;
    html: (siteId: string, blockId: string) => string;
    css: (siteId: string, blockId: string) => string;
    js: (siteId: string, blockId: string) => string;
    metadata: (siteId: string, blockId: string) => string;
  };
  pages: {
    screenshot: (siteId: string, pageId: string) => string;
    html: (siteId: string, pageId: string) => string;
  };
  designSystems: {
    tokens: (siteId: string) => string;
    preview: (siteId: string) => string;
  };
}

export const paths: StoragePaths = {
  blocks: {
    screenshot: (siteId, blockId) => `blocks/${siteId}/${blockId}/screenshot.png`,
    html: (siteId, blockId) => `blocks/${siteId}/${blockId}/html.txt`,
    css: (siteId, blockId) => `blocks/${siteId}/${blockId}/css.txt`,
    js: (siteId, blockId) => `blocks/${siteId}/${blockId}/js.txt`,
    metadata: (siteId, blockId) => `blocks/${siteId}/${blockId}/metadata.json`,
  },
  pages: {
    screenshot: (siteId, pageId) => `pages/${siteId}/${pageId}/screenshot.png`,
    html: (siteId, pageId) => `pages/${siteId}/${pageId}/html.txt`,
  },
  designSystems: {
    tokens: (siteId) => `design-systems/${siteId}/tokens.json`,
    preview: (siteId) => `design-systems/${siteId}/preview.png`,
  },
};

// ============================================
// Upload Operations
// ============================================

export async function uploadText(
  bucket: R2Bucket,
  path: string,
  content: string,
  contentType: string = 'text/plain'
): Promise<string> {
  await bucket.put(path, content, {
    httpMetadata: {
      contentType,
    },
  });
  return path;
}

export async function uploadJSON(
  bucket: R2Bucket,
  path: string,
  data: unknown
): Promise<string> {
  const content = JSON.stringify(data, null, 2);
  await bucket.put(path, content, {
    httpMetadata: {
      contentType: 'application/json',
    },
  });
  return path;
}

export async function uploadImage(
  bucket: R2Bucket,
  path: string,
  data: ArrayBuffer | Uint8Array,
  contentType: string = 'image/png'
): Promise<string> {
  await bucket.put(path, data, {
    httpMetadata: {
      contentType,
    },
  });
  return path;
}

export async function uploadBlob(
  bucket: R2Bucket,
  path: string,
  data: ArrayBuffer | Uint8Array | ReadableStream,
  contentType: string
): Promise<string> {
  await bucket.put(path, data, {
    httpMetadata: {
      contentType,
    },
  });
  return path;
}

// ============================================
// Download Operations
// ============================================

export async function downloadText(
  bucket: R2Bucket,
  path: string
): Promise<string | null> {
  const object = await bucket.get(path);
  if (!object) return null;
  return object.text();
}

export async function downloadJSON<T>(
  bucket: R2Bucket,
  path: string
): Promise<T | null> {
  const text = await downloadText(bucket, path);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function downloadImage(
  bucket: R2Bucket,
  path: string
): Promise<ArrayBuffer | null> {
  const object = await bucket.get(path);
  if (!object) return null;
  return object.arrayBuffer();
}

export async function downloadBlob(
  bucket: R2Bucket,
  path: string
): Promise<{ data: ArrayBuffer; contentType: string } | null> {
  const object = await bucket.get(path);
  if (!object) return null;
  return {
    data: await object.arrayBuffer(),
    contentType: object.httpMetadata?.contentType || 'application/octet-stream',
  };
}

// ============================================
// Delete Operations
// ============================================

export async function deleteObject(bucket: R2Bucket, path: string): Promise<void> {
  await bucket.delete(path);
}

export async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined;

  do {
    const listed = await bucket.list({ prefix, cursor });
    if (listed.objects.length === 0) break;

    const keys = listed.objects.map((obj) => obj.key);
    await Promise.all(keys.map((key) => bucket.delete(key)));
    deleted += keys.length;

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return deleted;
}

// ============================================
// Block Storage Operations
// ============================================

export interface BlockStorageData {
  html: string;
  css?: string;
  js?: string;
  screenshot?: ArrayBuffer;
  metadata?: Record<string, unknown>;
}

export async function storeBlock(
  bucket: R2Bucket,
  siteId: string,
  blockId: string,
  data: BlockStorageData
): Promise<{
  htmlUrl: string;
  cssUrl: string | null;
  jsUrl: string | null;
  screenshotUrl: string | null;
  metadataUrl: string | null;
}> {
  const results = await Promise.all([
    uploadText(bucket, paths.blocks.html(siteId, blockId), data.html, 'text/html'),
    data.css
      ? uploadText(bucket, paths.blocks.css(siteId, blockId), data.css, 'text/css')
      : Promise.resolve(null),
    data.js
      ? uploadText(bucket, paths.blocks.js(siteId, blockId), data.js, 'text/javascript')
      : Promise.resolve(null),
    data.screenshot
      ? uploadImage(bucket, paths.blocks.screenshot(siteId, blockId), data.screenshot)
      : Promise.resolve(null),
    data.metadata
      ? uploadJSON(bucket, paths.blocks.metadata(siteId, blockId), data.metadata)
      : Promise.resolve(null),
  ]);

  return {
    htmlUrl: results[0],
    cssUrl: results[1],
    jsUrl: results[2],
    screenshotUrl: results[3],
    metadataUrl: results[4],
  };
}

export async function getBlock(
  bucket: R2Bucket,
  siteId: string,
  blockId: string
): Promise<BlockStorageData | null> {
  const html = await downloadText(bucket, paths.blocks.html(siteId, blockId));
  if (!html) return null;

  const [css, js, screenshot, metadata] = await Promise.all([
    downloadText(bucket, paths.blocks.css(siteId, blockId)),
    downloadText(bucket, paths.blocks.js(siteId, blockId)),
    downloadImage(bucket, paths.blocks.screenshot(siteId, blockId)),
    downloadJSON<Record<string, unknown>>(bucket, paths.blocks.metadata(siteId, blockId)),
  ]);

  return {
    html,
    css: css || undefined,
    js: js || undefined,
    screenshot: screenshot || undefined,
    metadata: metadata || undefined,
  };
}

export async function deleteBlock(
  bucket: R2Bucket,
  siteId: string,
  blockId: string
): Promise<void> {
  await deletePrefix(bucket, `blocks/${siteId}/${blockId}/`);
}

// ============================================
// Page Storage Operations
// ============================================

export interface PageStorageData {
  html: string;
  screenshot?: ArrayBuffer;
}

export async function storePage(
  bucket: R2Bucket,
  siteId: string,
  pageId: string,
  data: PageStorageData
): Promise<{ htmlUrl: string; screenshotUrl: string | null }> {
  const [htmlUrl, screenshotUrl] = await Promise.all([
    uploadText(bucket, paths.pages.html(siteId, pageId), data.html, 'text/html'),
    data.screenshot
      ? uploadImage(bucket, paths.pages.screenshot(siteId, pageId), data.screenshot)
      : Promise.resolve(null),
  ]);

  return { htmlUrl, screenshotUrl };
}

export async function getPage(
  bucket: R2Bucket,
  siteId: string,
  pageId: string
): Promise<PageStorageData | null> {
  const html = await downloadText(bucket, paths.pages.html(siteId, pageId));
  if (!html) return null;

  const screenshot = await downloadImage(bucket, paths.pages.screenshot(siteId, pageId));

  return {
    html,
    screenshot: screenshot || undefined,
  };
}

export async function deletePage(
  bucket: R2Bucket,
  siteId: string,
  pageId: string
): Promise<void> {
  await deletePrefix(bucket, `pages/${siteId}/${pageId}/`);
}

// ============================================
// Design System Storage Operations
// ============================================

export interface DesignSystemStorageData {
  tokens: Record<string, unknown>;
  preview?: ArrayBuffer;
}

export async function storeDesignSystem(
  bucket: R2Bucket,
  siteId: string,
  data: DesignSystemStorageData
): Promise<{ tokensUrl: string; previewUrl: string | null }> {
  const [tokensUrl, previewUrl] = await Promise.all([
    uploadJSON(bucket, paths.designSystems.tokens(siteId), data.tokens),
    data.preview
      ? uploadImage(bucket, paths.designSystems.preview(siteId), data.preview)
      : Promise.resolve(null),
  ]);

  return { tokensUrl, previewUrl };
}

export async function getDesignSystem(
  bucket: R2Bucket,
  siteId: string
): Promise<DesignSystemStorageData | null> {
  const tokens = await downloadJSON<Record<string, unknown>>(
    bucket,
    paths.designSystems.tokens(siteId)
  );
  if (!tokens) return null;

  const preview = await downloadImage(bucket, paths.designSystems.preview(siteId));

  return {
    tokens,
    preview: preview || undefined,
  };
}

export async function deleteDesignSystem(bucket: R2Bucket, siteId: string): Promise<void> {
  await deletePrefix(bucket, `design-systems/${siteId}/`);
}

// ============================================
// Site Cleanup Operations
// ============================================

export async function deleteSiteData(bucket: R2Bucket, siteId: string): Promise<number> {
  let total = 0;
  total += await deletePrefix(bucket, `blocks/${siteId}/`);
  total += await deletePrefix(bucket, `pages/${siteId}/`);
  total += await deletePrefix(bucket, `design-systems/${siteId}/`);
  return total;
}

// ============================================
// List Operations
// ============================================

export async function listBlockIds(bucket: R2Bucket, siteId: string): Promise<string[]> {
  const prefix = `blocks/${siteId}/`;
  const ids = new Set<string>();
  let cursor: string | undefined;

  do {
    const listed = await bucket.list({ prefix, cursor, delimiter: '/' });
    for (const obj of listed.delimitedPrefixes || []) {
      const blockId = obj.replace(prefix, '').replace('/', '');
      if (blockId) ids.add(blockId);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return Array.from(ids);
}

export async function listPageIds(bucket: R2Bucket, siteId: string): Promise<string[]> {
  const prefix = `pages/${siteId}/`;
  const ids = new Set<string>();
  let cursor: string | undefined;

  do {
    const listed = await bucket.list({ prefix, cursor, delimiter: '/' });
    for (const obj of listed.delimitedPrefixes || []) {
      const pageId = obj.replace(prefix, '').replace('/', '');
      if (pageId) ids.add(pageId);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return Array.from(ids);
}

// ============================================
// Utility Functions
// ============================================

export function getPublicUrl(bucketUrl: string, path: string): string {
  return `${bucketUrl.replace(/\/$/, '')}/${path}`;
}

export async function objectExists(bucket: R2Bucket, path: string): Promise<boolean> {
  const head = await bucket.head(path);
  return head !== null;
}

export async function getObjectSize(bucket: R2Bucket, path: string): Promise<number | null> {
  const head = await bucket.head(path);
  return head?.size ?? null;
}
