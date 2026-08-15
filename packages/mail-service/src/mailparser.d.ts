declare module "mailparser" {
  export interface AddressObjectLike {
    text?: string;
  }

  export interface AttachmentLike {
    filename?: string | null;
    contentType?: string | null;
    size?: number | null;
  }

  export interface ParsedMailLike {
    from?: AddressObjectLike;
    to?: AddressObjectLike;
    cc?: AddressObjectLike;
    subject?: string | null;
    date?: Date | null;
    html?: string | Buffer | false | null;
    text?: string | null;
    messageId?: string | null;
    /** RFC 5322 In-Reply-To. */
    inReplyTo?: string | null;
    /** RFC 5322 References. mailparser yields an array for multiple ids and a bare
     *  string when there is exactly one, so consumers must handle both. */
    references?: string[] | string | null;
    attachments?: AttachmentLike[];
  }

  export function simpleParser(source: Buffer | string): Promise<ParsedMailLike>;
}