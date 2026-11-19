/**
 * The fields of an image request as one record, whether it went as JSON (a new picture) or as a
 * form (every edit): form numbers are read back as numbers and file parts as bare base64, the
 * shape the JSON body carried them in. So a test can assert on what was asked without caring which
 * transport carried it; a test about the transport checks `body instanceof FormData` itself.
 */
export async function imageRequestFields(body: unknown): Promise<Record<string, unknown>> {
  if (!(body instanceof FormData)) return JSON.parse(String(body)) as Record<string, unknown>;
  const pairs: Array<[string, FormDataEntryValue]> = [];
  body.forEach((value, key) => { pairs.push([key, value]); });
  const fields: Record<string, unknown> = {};
  for (const [key, value] of pairs) {
    fields[key] = typeof value === "string"
      ? (/^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : value)
      : Buffer.from(await value.arrayBuffer()).toString("base64");
  }
  return fields;
}
