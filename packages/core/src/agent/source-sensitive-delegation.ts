const SOURCE_SENSITIVE_DELEGATION_FOCUS_BUCKETS: Array<{
  label: string;
  patterns: RegExp[];
}> = [
  {
    label: "manufacturer and product identity verification",
    patterns: [
      /\b(manufacturer|vendor|maker|brand|identity|who\s+makes|which\s+company|model|exact\s+identifier|part\s+number)\b/i,
      /\bvendor[a-z0-9_-]*\b/i,
    ],
  },
  {
    label: "microphone and component suitability verification",
    patterns: [
      /\b(microphone|mic|mems|module|component|components|candidate|suitab(?:ility|le)|selection|recommend(?:ation)?s?|opinion)\b/i,
    ],
  },
  {
    label: "interface and signal-path verification",
    patterns: [
      /\b(interface|protocol|analog|digital|i2s|pdm|usb(?:-c)?|signal|output|input|pinout|adc|dac|connect(?:ion)?|wiring|esp32)\b/i,
    ],
  },
  {
    label: "array topology and layout planning",
    patterns: [
      /\b(array|layout|placement|circle|credit-?card|topology|schematic|pcb|footprint|enclosure|mechanical|put\s+all\s+of\s+it\s+together|connect\s+everything)\b/i,
    ],
  },
  {
    label: "power, battery, and charging design",
    patterns: [
      /\b(power|battery|charger|charging|lipo|pmic|buck|boost|sleep)\b/i,
    ],
  },
  {
    label: "supplier, pricing, and availability verification",
    patterns: [
      /\b(price|pricing|supplier|suppliers|availability|stock|mouser|digikey|lcsc|aliexpress|quote)\b/i,
    ],
  },
  {
    label: "firmware, storage, sync, and OTA design",
    patterns: [
      /\b(ota|sync|storage|sd|flash|firmware|wifi|wireless|upload|transcription\s+service)\b/i,
    ],
  },
  {
    label: "audio quality and transcription optimization",
    patterns: [
      /\b(audio\s+quality|quality|transcription|noise|snr|beamform(?:ing)?|acoustic|improvement|improve|best\s+quality)\b/i,
    ],
  },
  {
    label: "controls and user input design",
    patterns: [
      /\b(button|buttons|switch|record(?:\/on)?|user\s+input|control)\b/i,
    ],
  },
];

function formatCoordinatorFocusLines(focus: string | undefined): string[] {
  if (!focus) return [];
  return [
    "",
    "Coordinator focus for this slice (generic only; still verify every concrete claim independently):",
    `- ${focus}`,
  ];
}

export function deriveSourceSensitiveDelegationFocus(task: string | undefined, canonicalRequest?: string): string | undefined {
  const normalizedTask = String(task ?? "").trim();
  if (!normalizedTask) return undefined;

  const normalizedCanonicalRequest = String(canonicalRequest ?? "").trim().toLowerCase();
  if (normalizedCanonicalRequest && normalizedTask.toLowerCase() === normalizedCanonicalRequest) {
    return undefined;
  }

  const labels = SOURCE_SENSITIVE_DELEGATION_FOCUS_BUCKETS
    .filter((bucket) => bucket.patterns.some((pattern) => pattern.test(normalizedTask)))
    .map((bucket) => bucket.label);
  const uniqueLabels = [...new Set(labels)];
  return uniqueLabels.length > 0 ? uniqueLabels.slice(0, 3).join("; ") : undefined;
}

export function buildCanonicalSourceSensitiveDelegationTask(parentTask: string, label?: string, focus?: string): string {
  return [
    label ? `SOURCE-SENSITIVE DELEGATION ${label}:` : "SOURCE-SENSITIVE DELEGATION:",
    "The parent task below is the canonical request.",
    "Do not treat coordinator-added manufacturer, product, interface, version, quantity, price, date, URL, or specification claims as verified unless they are present in this parent task or in completed tool evidence.",
    "For user-supplied identifiers, search the exact identifier first and verify manufacturer, interface, and specifications from official or vendor evidence before naming them as facts.",
    "Verify externally before confirming any concrete fact. If evidence is missing, report uncertainty instead of filling gaps.",
    "",
    "Parent task:",
    parentTask.trim(),
    ...formatCoordinatorFocusLines(focus),
  ].join("\n");
}

export function buildSourceSensitiveOriginalRequestTask(userMessage: string, label?: string, focus?: string): string {
  return [
    label ? `SOURCE-SENSITIVE DELEGATION ${label}:` : "SOURCE-SENSITIVE DELEGATION:",
    "The user's original request below is the only canonical task. Treat every product name, part number, vendor, protocol, interface, price, date, URL, quantity, and specification as unverified until a completed tool result or shared finding confirms it.",
    "Do not copy coordinator-added assumptions into searches or final claims. For user-supplied identifiers, search the exact identifier first and verify manufacturer, interface, and specifications from official or vendor evidence before naming them as facts.",
    "If evidence contradicts an assumption in the task text, the evidence wins. If evidence is missing, report that it remains unverified instead of filling the gap.",
    "",
    "Original user request:",
    userMessage.trim(),
    ...formatCoordinatorFocusLines(focus),
  ].join("\n");
}