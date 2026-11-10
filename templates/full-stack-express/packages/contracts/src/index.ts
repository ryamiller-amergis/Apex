export {
  defineRoute,
  forbiddenIdentifierFields,
  httpMethods,
  type AnyRoute,
  type HttpMethod,
  type InferBody,
  type InferHeaders,
  type InferParams,
  type InferQuery,
  type InferResponse,
  type ProblemResponse,
  type RouteAuth,
  type RouteDefinition,
  type RouteInput,
  type RouteRequest,
  type RouteResponse,
  type RouteResponses,
  type StandardResponses,
} from './define-route.ts';
export { routeKey, routeList, routes, type RouteLocation } from './registry.ts';
export {
  compareRouteInventory,
  type RouteInventoryResult,
} from './inventory.ts';
export {
  problemContentType,
  problemDetailsSchema,
  problemErrorSchema,
  problemTypes,
  zodIssuesToProblemErrors,
  type ProblemDetails,
  type ProblemError,
  type ProblemType,
} from './conventions/problem-details.ts';
export {
  requestIdHeader,
  requestIdSchema,
  type RequestId,
} from './conventions/request-id.ts';
export {
  defaultPageSize,
  maxCursorLength,
  maxPageSize,
  paginated,
  paginationQuerySchema,
  type PaginationQuery,
} from './conventions/pagination.ts';
export {
  isVersionedPath,
  pathParameterNames,
  toOpenApiPath,
} from './conventions/versioning.ts';
export {
  getHealthLive,
  getHealthReady,
  healthLiveSchema,
  healthReadySchema,
} from './routes/health.ts';
export {
  displayNameMaxLength,
  displayNameSchema,
  emailMaxLength,
  emailSchema,
  getMe,
  profileSchema,
  profileStatusSchema,
  profileStatusValues,
  putMe,
  updateProfileBodySchema,
  type Profile,
  type ProfileStatus,
  type UpdateProfileBody,
} from './routes/me.ts';
export {
  createNotification,
  createNotificationBodySchema,
  getNotifications,
  markNotificationReadBodySchema,
  markNotificationsRead,
  notificationCategorySchema,
  notificationCategoryValues,
  notificationItemSchema,
  notificationsListSchema,
  type CreateNotificationBody,
  type MarkNotificationReadBody,
  type NotificationCategory,
  type NotificationItem,
  type NotificationsList,
} from './routes/notifications.ts';
export {
  analyzeInsights,
  analyzeInsightsBodySchema,
  insightCitationSchema,
  insightFindingSchema,
  insightsAnalysisSchema,
  insightSourceKindSchema,
  insightSourceKindValues,
  type AnalyzeInsightsBody,
  type InsightCitation,
  type InsightFinding,
  type InsightsAnalysis,
  type InsightSourceKind,
} from './routes/insights.ts';

// Read by apps/web/src/main.tsx until FEAT-010 replaces that entry point.
export const CONTRACTS_STUB = 'contracts-stub';
