import { EXPENSE_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as expenses from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Expenses and petty cash (M10-06; T-147). */
export function expenseRoutes(deps: expenses.ExpenseDeps): Router {
  const router = express.Router();
  const r = EXPENSE_ROUTES;
  mountRoute(router, r.getExpenseSetup, (_in, { tenant }) =>
    expenses.getExpenseSetup(deps, tenantFrom(tenant)),
  );
  mountRoute(router, r.createExpenseCategory, ({ body }) =>
    expenses.createExpenseCategory(deps, body),
  );
  mountRoute(router, r.updateExpenseCategory, ({ params, body }) =>
    expenses.updateExpenseCategory(deps, params.categoryId, body),
  );
  mountRoute(router, r.createPettyCashFloat, ({ body }, { tenant }) =>
    expenses.createPettyCashFloat(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.updatePettyCashFloat, ({ params, body }, { tenant }) =>
    expenses.updatePettyCashFloat(deps, tenantFrom(tenant), params.floatId, body),
  );
  mountRoute(router, r.topUpPettyCash, ({ params, body }, { tenant }) =>
    expenses.topUpPettyCash(deps, tenantFrom(tenant), params.floatId, body),
  );
  mountRoute(router, r.listExpenses, ({ query }) => expenses.listExpenses(deps, query));
  mountRoute(router, r.recordExpense, ({ body }, { tenant }) =>
    expenses.recordExpense(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.voidExpense, ({ params, body }, { tenant }) =>
    expenses.voidExpense(deps, tenantFrom(tenant), params.expenseId, body),
  );
  return router;
}
