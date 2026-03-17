import { deleteCredential, getCredential, setCredential } from "./store.js";
import type { ChannelType } from "./channels.js";

const PAIRING_KEY = (channel: ChannelType) => `channel:${channel}:paired`;

function readPairedSenders(channel: ChannelType): string[] {
  const raw = getCredential(PAIRING_KEY(channel));
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((value): value is string => typeof value === "string" && value.length > 0))].sort();
  } catch {
    return [];
  }
}

function writePairedSenders(channel: ChannelType, senderIds: string[]): void {
  if (senderIds.length === 0) {
    deleteCredential(PAIRING_KEY(channel));
    return;
  }

  setCredential(PAIRING_KEY(channel), JSON.stringify([...new Set(senderIds)].sort()));
}

export function listPairedSenders(channel: ChannelType): string[] {
  return readPairedSenders(channel);
}

export function isSenderPaired(channel: ChannelType, senderId: string): boolean {
  return readPairedSenders(channel).includes(senderId);
}

export function pairSender(channel: ChannelType, senderId: string): void {
  const senderIds = readPairedSenders(channel);
  if (senderIds.includes(senderId)) return;
  senderIds.push(senderId);
  writePairedSenders(channel, senderIds);
}

export function unpairSender(channel: ChannelType, senderId: string): void {
  const senderIds = readPairedSenders(channel).filter((value) => value !== senderId);
  writePairedSenders(channel, senderIds);
}