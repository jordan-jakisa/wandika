export interface User {
  login: string;
  name: string | null;
  avatar_url: string;
}

export interface Target {
  owner: string;
  repo: string;
  branch: string;
}

export type AppleAccess = "unsupported" | "not_asked" | "granted" | "denied";

export interface CryptoStatus {
  set_up: boolean;
  unlocked: boolean;
  folders: string[];
}

export interface Status {
  configured: { github: boolean; google: boolean; microsoft: boolean; apple: boolean };
  user: User | null;
  target: Target | null;
  last_sync: number | null;
  encryption: CryptoStatus | null;
  connectors: {
    google: string | null;
    microsoft: string | null;
    apple_calendar: AppleAccess;
    apple_reminders: AppleAccess;
  };
}

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface Repo {
  name: string;
  full_name: string;
  owner: { login: string };
  private: boolean;
  default_branch: string | null;
  description: string | null;
  pushed_at: string | null;
}

export interface SyncReport {
  pulled: string[];
  pushed: string[];
  removed: string[];
  merged: string[];
  conflicts: string[];
  too_big: string[];
  head: string | null;
  at: number;
}

export interface Entry {
  path: string;
  name: string;
  kind: "folder" | "note" | "file";
  encrypted: boolean;
  modified: number;
}

export interface NoteMeta {
  path: string;
  title: string;
  links: string[];
  tags: string[];
  encrypted: boolean;
  locked: boolean;
  modified: number;
}

export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
  encrypted: boolean;
}

export interface VaultTask {
  path: string;
  title: string;
  line: number;
  text: string;
  done: boolean;
  due: string | null;
}

export interface CalEvent {
  id: string;
  source: "google" | "microsoft" | "apple";
  calendar: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location: string | null;
  url: string | null;
  attendees: string[];
}

export interface MailItem {
  id: string;
  source: "google" | "microsoft";
  subject: string;
  from: string;
  date: string;
  snippet: string;
  url: string | null;
  unread: boolean;
}

export interface RemoteTask {
  id: string;
  source: "google" | "apple";
  list_id: string;
  list: string;
  title: string;
  done: boolean;
  due: string | null;
}

export interface Today {
  events: CalEvent[];
  mail: MailItem[];
  tasks: VaultTask[];
  remote_tasks: RemoteTask[];
  errors: Record<string, string>;
}

export type ConnectStart =
  | { kind: "browser" }
  | { kind: "device"; device_code: string; user_code: string; verification_uri: string; interval: number }
  | { kind: "done"; access: AppleAccess };
