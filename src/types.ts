export type ProviderId = "claude-code" | "codex" | "copilot" | "gemini";

export interface CliOptions {
  compactSqlite: boolean;
  dryRun: boolean;
  ignoredProjectTerms: string[];
  includeOrphaned: boolean;
  json: boolean;
  largerThanBytes: number | null;
  now: Date;
  olderThanDays: number | null;
  providerIds: ProviderId[] | null;
  yes: boolean;
}

export interface SessionCandidate<TInternal = unknown> {
  bytes: number;
  createdAt: Date | null;
  current: boolean;
  id: string;
  internal: TInternal;
  projectName: string | null;
  projectPath: string | null;
  providerId: ProviderId;
  providerName: string;
  reasons: string[];
  title: string | null;
  updatedAt: Date;
}

export interface ProjectCandidate<TInternal = unknown> {
  bytes: number;
  createdAt: Date | null;
  displayName: string;
  internal: TInternal;
  key: string;
  projectPath: string | null;
  providerId: ProviderId;
  providerName: string;
  reasons: string[];
  updatedAt: Date | null;
}

export interface ProviderScanResult<TSession = unknown, TProject = unknown> {
  notes: string[];
  projects: ProjectCandidate<TProject>[];
  providerId: ProviderId;
  providerName: string;
  sessions: SessionCandidate<TSession>[];
  warnings: string[];
}

export interface ProviderApplyResult {
  deletedBytes: number;
  deletedProjects: number;
  deletedSessions: number;
  notes: string[];
  providerId: ProviderId;
  providerName: string;
  warnings: string[];
}

export interface AgentProvider<TSession = unknown, TProject = unknown> {
  apply(
    result: ProviderScanResult<TSession, TProject>,
    options: CliOptions,
  ): Promise<ProviderApplyResult>;
  id: ProviderId;
  name: string;
  scan(
    options: CliOptions,
  ): Promise<ProviderScanResult<TSession, TProject> | null>;
}

export interface ProviderExecution<TSession = unknown, TProject = unknown> {
  provider: AgentProvider<TSession, TProject>;
  result: ProviderScanResult<TSession, TProject>;
}
