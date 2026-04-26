// --- Error Types ---
export interface PipedriveApiError {
  error: true;
  code: number;
  message: string;
  details?: Record<string, unknown>;
}

// --- Pagination ---
export interface CursorPayload {
  v: 'v1' | 'v2';
  offset?: number;
  cursor?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  has_more: boolean;
  next_cursor?: string;
}

// --- Summary Shapes ---
export interface DealSummary {
  id: number;
  title: string;
  status: string;
  pipeline: string;
  stage: string;
  owner: string;
  value: number | null;
  updated_at: string;
}

export interface PersonSummary {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  organization: string | null;
  owner: string;
  updated_at: string;
}

export interface OrganizationSummary {
  id: number;
  name: string;
  owner: string;
  address: string | null;
  updated_at: string;
}

export interface ActivitySummary {
  id: number;
  type: string;
  subject: string;
  due_date: string | null;
  done: boolean;
  deal: string | null;
  person: string | null;
  owner: string;
}

export interface NoteSummary {
  id: number;
  content: string;
  truncated: boolean;
  deal: string | null;
  person: string | null;
  org: string | null;
  updated_at: string;
}

// --- Delete ---
export interface DeleteConfirmation {
  confirm_required: true;
  message: string;
}

export interface DeleteResult {
  id: number;
  title?: string;
  name?: string;
  deleted: true;
}

// --- Field Definitions ---
export interface FieldDefinition {
  key: string;
  name: string;
  field_type: string;
  options?: FieldOption[];
  max_length?: number;
}

export interface FieldOption {
  id: number;
  label: string;
}

// --- Reference Data ---
export interface PipedriveUser {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

export interface PipedrivePipeline {
  id: number;
  name: string;
  active: boolean;
  stages: PipedriveStage[];
}

export interface PipedriveStage {
  id: number;
  name: string;
  pipeline_id: number;
  order_nr: number;
  rotten_flag: boolean;
  rotten_days: number | null;
}

// --- Config ---
export type ToolCategory = 'read' | 'create' | 'update' | 'delete';

export interface ServerConfig {
  port: number;
  transport: 'stdio' | 'sse';
  enabledCategories: Set<ToolCategory>;
  disabledTools: Set<string>;
  logLevel: 'info' | 'debug';
}

// --- Tool Registration ---
export interface ToolDefinition {
  name: string;
  category: ToolCategory;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}

// --- Pipedrive Client ---
export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface ApiRoute {
  version: 'v1' | 'v2';
  path: string;
  method: HttpMethod;
}

export interface RateLimitState {
  remaining: number | null;
  resetTimestamp: number | null;
}
