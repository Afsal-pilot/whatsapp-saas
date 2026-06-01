/**
 * Type definitions mirroring Meta's WhatsApp Cloud API contract.
 *
 * Source: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 *
 * Keep these aligned with Meta's spec — they're sent verbatim in API payloads.
 */

export type SendResult = { wa_message_id: string };

/** Optional per-call overrides. Defaults come from META_PHONE_NUMBER_ID /
 *  META_ACCESS_TOKEN in process.env. Override per-tenant when sending on
 *  behalf of a tenant who connected via Embedded Signup. */
export type SendOpts = {
  /** Override the default phone_number_id (per-tenant routing). */
  phoneNumberId?: string;
  /** Override the default access token (per-tenant tokens from Embedded Signup). */
  accessToken?: string;
  /** Correlation id for log tracing. */
  requestId?: string;
};

// ─── interactive payloads (existing) ────────────────────────────────────────

export type ButtonsPayload = {
  body: string;
  /** 1–3. Each `title` is shown on the button (max 20 chars per Meta). */
  buttons: Array<{ id: string; title: string }>;
  /** Optional small header text shown above the body. Max 60 chars. */
  header?: string;
  /** Optional small footer text shown under the buttons. Max 60 chars. */
  footer?: string;
};

export type ListPayload = {
  body: string;
  /** The CTA on the dropdown the user taps to expand the list. Max 20 chars. */
  buttonText: string;
  sections: Array<{
    /** Optional — Meta requires it only when there are 2+ sections. */
    title?: string;
    rows: Array<{ id: string; title: string; description?: string }>;
  }>;
  header?: string;
  footer?: string;
};

// ─── template payloads (Meta Cloud API spec) ────────────────────────────────

export type TemplateLanguage = {
  /** BCP-47-ish code Meta uses, e.g. 'en_US', 'hi_IN', 'pt_BR'. */
  code: string;
};

/**
 * A single parameter slot inside a template component. Type discriminates the
 * concrete payload shape. Matches Meta's parameter spec verbatim.
 */
export type TemplateParameter =
  | { type: "text"; text: string }
  | { type: "image"; image: { link: string } | { id: string } }
  | { type: "video"; video: { link: string } | { id: string } }
  | { type: "document"; document: { link: string; filename?: string } | { id: string; filename?: string } }
  | {
      type: "currency";
      currency: { fallback_value: string; code: string; amount_1000: number };
    }
  | { type: "date_time"; date_time: { fallback_value: string } };

/**
 * A template component. Component type determines which parameter kinds are
 * legal at that slot. Header media (IMAGE/VIDEO/DOCUMENT) goes in the
 * 'header' component; body text variables go in 'body'; dynamic URL buttons
 * go in 'button' with sub_type='url' and an index.
 */
export type TemplateComponent =
  | { type: "header"; parameters: TemplateParameter[] }
  | { type: "body"; parameters: TemplateParameter[] }
  | {
      type: "button";
      sub_type: "url" | "quick_reply";
      /** Zero-based index of the button in the template's button array. */
      index: string;
      parameters: TemplateParameter[];
    };

export type TemplateMessage = {
  /** Meta-approved template name (snake_case) registered on the WABA. */
  name: string;
  language: TemplateLanguage;
  /** Optional — only required if the template has variable slots. */
  components?: TemplateComponent[];
};
