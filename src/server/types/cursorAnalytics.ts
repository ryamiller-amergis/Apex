// ── Cursor Admin API types ─────────────────────────────────────────────────────

export interface CursorTeamMember {
  id: number;
  email: string;
  name: string;
  role: string;
  isRemoved: boolean;
}

export interface CursorTeamMembersResponse {
  teamMembers: CursorTeamMember[];
}

/** One row from POST /teams/daily-usage-data */
export interface CursorDailyUsageRow {
  userId: number;
  day: string;          // ISO date "2024-03-18"
  date: number;         // epoch ms
  email: string;
  isActive?: boolean;   // present only when using pagination
  totalLinesAdded: number;
  totalLinesDeleted: number;
  acceptedLinesAdded: number;
  acceptedLinesDeleted: number;
  totalApplies: number;
  totalAccepts: number;
  cmdkUsages: number;
  usageBasedReqs: number;
  bugbotUsages: number;
}

export interface CursorDailyUsageResponse {
  data: CursorDailyUsageRow[];
  pagination?: {
    page: number;
    pageSize: number;
    totalPages: number;
    hasNextPage: boolean;
  };
}

// ── Cursor Analytics API types ─────────────────────────────────────────────────

export interface CursorDauRow {
  date: string;
  dau: number;
  cli_dau: number;
  cloud_agent_dau: number;
  bugbot_dau: number;
}

export interface CursorDauResponse {
  data: CursorDauRow[];
}

export interface CursorAgentEditsRow {
  event_date: string;
  total_suggested_diffs: number;
  total_accepted_diffs: number;
  total_rejected_diffs: number;
  total_lines_suggested: number;
  total_lines_accepted: number;
}

export interface CursorAgentEditsResponse {
  data: CursorAgentEditsRow[];
}

export interface CursorTabsRow {
  event_date: string;
  total_suggestions: number;
  total_accepts: number;
  total_rejects: number;
  total_lines_suggested: number;
  total_lines_accepted: number;
}

export interface CursorTabsResponse {
  data: CursorTabsRow[];
}

export interface CursorSkillRow {
  event_date: string;
  skill_name: string;
  usage: number;
}

export interface CursorSkillsResponse {
  data: CursorSkillRow[];
}

export interface CursorMcpRow {
  event_date: string;
  tool_name: string;
  mcp_server_name: string;
  usage: number;
}

export interface CursorMcpResponse {
  data: CursorMcpRow[];
}

export interface CursorCommandRow {
  event_date: string;
  command_name: string;
  usage: number;
}

export interface CursorCommandsResponse {
  data: CursorCommandRow[];
}

export interface CursorPlansRow {
  event_date: string;
  model: string;
  usage: number;
}

export interface CursorPlansResponse {
  data: CursorPlansRow[];
}

export interface CursorLeaderboardUser {
  rank: number;
  userId: number;
  email: string;
  name: string;
  totalLinesAccepted: number;
  totalSuggestions: number;
  totalAccepts: number;
}

export interface CursorLeaderboardResponse {
  tab: { users: CursorLeaderboardUser[] };
  agentEdits: { users: CursorLeaderboardUser[] };
}

// ── Normalized aggregate types used by the scoring service ────────────────────

/** Per-developer summary built by merging Cursor user + usage data */
export interface CursorDeveloperSummary {
  email: string;
  name: string;
  cursorId: number;
  role: string;
  /** Active days (any AI feature used) within the requested window */
  activeDays: number;
  /** Total calendar days in the window */
  windowDays: number;
  /** Fraction of working days active (activeDays / windowDays) */
  dauFraction: number;
  /** Longest consecutive-active-week streak (weeks where >=1 active day) */
  sustainedWeeks: number;
  totalAcceptedLines: number;
  totalApplies: number;
  totalAccepts: number;
  cmdkUsages: number;
  bugbotUsages: number;
}

/** Team-level Cursor usage summary */
export interface CursorTeamSummary {
  teamSize: number;
  /** Number of active (non-removed) Cursor seats */
  activeSeats: number;
  developers: CursorDeveloperSummary[];
  /** Daily DAU time series for the window */
  dauSeries: CursorDauRow[];
  /** Number of unique days where team DAU / teamSize >= 0.5 */
  daysAbove50pct: number;
  /** Number of unique days where team DAU / teamSize >= 0.8 */
  daysAbove80pct: number;
  /** Consecutive complete weeks with >=50% DAU (partial current week excluded) */
  weeksAbove50pct: number;
  /** Consecutive complete weeks with >=80% DAU (partial current week excluded) */
  weeksAbove80pct: number;
  /** Average DAU as a fraction of teamSize over the last 14 calendar days */
  recentDauPct: number;
  /** Number of days in the window where DAU data was returned */
  totalDauDays: number;
  tabAcceptRate: number;
  agentEditAcceptRate: number;
  /** All skills used by the team */
  skillsInUse: string[];
  /** Total skill usages */
  totalSkillUsages: number;
  mcpToolsInUse: string[];
  planModeUsages: number;
  commandsUsed: string[];
}
