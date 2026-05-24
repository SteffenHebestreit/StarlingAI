import { describe, it, expect } from "vitest";
import { parseSnapshotElements, pickLoginRefs } from "../tools/credentials.js";

// Snapshot excerpts mirror the Playwright accessibility format seen in audits.
const N8N_LOGIN = `
- generic [ref=e18]:
  - textbox "Email" [active] [ref=e34]:
  - textbox "Password" [ref=e45]:
  - button "Sign in" [ref=e47] [cursor=pointer]:
  - link "Forgot my password" [ref=e51]:
`;

const FREELANCERMAP_LOGIN_DE = `
- banner [ref=e2]:
  - textbox "E-Mail-Adresse oder Benutzername" [ref=e67]:
  - textbox "Passwort" [ref=e73]:
  - button "Anmelden" [ref=e77] [cursor=pointer]:
`;

const UNLABELED = `
- form [ref=e1]:
  - textbox [ref=e10]:
  - textbox "Passwort" [ref=e12]:
  - button "Weiter" [ref=e14]:
`;

describe("login field auto-location", () => {
  it("locates English n8n login fields", () => {
    const refs = pickLoginRefs(parseSnapshotElements(N8N_LOGIN));
    expect(refs).toEqual({ usernameRef: "e34", passwordRef: "e45", submitRef: "e47" });
  });

  it("locates German freelancermap login fields", () => {
    const refs = pickLoginRefs(parseSnapshotElements(FREELANCERMAP_LOGIN_DE));
    expect(refs).toEqual({ usernameRef: "e67", passwordRef: "e73", submitRef: "e77" });
  });

  it("falls back to the input before the password when the username is unlabeled", () => {
    const refs = pickLoginRefs(parseSnapshotElements(UNLABELED));
    expect(refs.usernameRef).toBe("e10");
    expect(refs.passwordRef).toBe("e12");
    expect(refs.submitRef).toBe("e14");
  });

  it("returns undefined refs when no inputs are present", () => {
    const refs = pickLoginRefs(parseSnapshotElements("- generic [ref=e1]:\n  - link \"Home\" [ref=e2]:"));
    expect(refs.usernameRef).toBeUndefined();
    expect(refs.passwordRef).toBeUndefined();
  });
});
