import type { OperationId } from '@hotel/shared';
import type { CrossTenantCase } from './tenancy.ts';

/**
 * One entry per property-scoped route in API_ROUTES. The tenancy suite fails when a
 * property-scoped route has no case here, so every new module route is checked for
 * cross-tenant leaks (test plan, suite 1). Modules add their cases as they are built.
 */
export const CROSS_TENANT_CASES: Partial<Record<OperationId, CrossTenantCase>> = {};
