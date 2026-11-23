import { STOCK_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as stock from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Inventory: items, movements, requisitions and stocktakes (M10-01, M10-02, M10-05; T-145). */
export function stockRoutes(deps: stock.StockDeps): Router {
  const router = express.Router();
  const r = STOCK_ROUTES;
  mountRoute(router, r.listStockItems, (_in, { tenant }) =>
    stock.listStockItems(deps, tenantFrom(tenant)),
  );
  mountRoute(router, r.createStockItem, ({ body }) => stock.createStockItem(deps, body));
  mountRoute(router, r.updateStockItem, ({ params, body }) =>
    stock.updateStockItem(deps, params.itemId, body),
  );
  mountRoute(router, r.createStockUnit, ({ body }) => stock.createStockUnit(deps, body));
  mountRoute(router, r.updateStockUnit, ({ params, body }) =>
    stock.updateStockUnit(deps, params.unitId, body),
  );
  mountRoute(router, r.createStockLocation, ({ body }) => stock.createStockLocation(deps, body));
  mountRoute(router, r.updateStockLocation, ({ params, body }) =>
    stock.updateStockLocation(deps, params.locationId, body),
  );
  mountRoute(router, r.listStockMovements, ({ query }) => stock.listStockMovements(deps, query));
  mountRoute(router, r.adjustStock, ({ body }, { tenant }) =>
    stock.adjustStock(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.transferStock, ({ body }, { tenant }) =>
    stock.transferStock(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.listRequisitions, ({ query }, { tenant }) =>
    stock.listRequisitions(deps, tenantFrom(tenant), query),
  );
  mountRoute(router, r.createRequisition, ({ body }, { tenant }) =>
    stock.createRequisition(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.cancelRequisition, ({ params }, { tenant }) =>
    stock.cancelRequisition(deps, tenantFrom(tenant), params.requisitionId),
  );
  mountRoute(router, r.issueRequisition, ({ params, body }, { tenant }) =>
    stock.issueRequisition(deps, tenantFrom(tenant), params.requisitionId, body),
  );
  mountRoute(router, r.closeRequisition, ({ params, body }, { tenant }) =>
    stock.closeRequisition(deps, tenantFrom(tenant), params.requisitionId, body),
  );
  mountRoute(router, r.listStocktakes, () => stock.listStocktakes(deps));
  mountRoute(router, r.startStocktake, ({ body }, { tenant }) =>
    stock.startStocktake(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.getStocktake, ({ params }) => stock.getStocktake(deps, params.stocktakeId));
  mountRoute(router, r.recordStocktakeCounts, ({ params, body }, { tenant }) =>
    stock.recordStocktakeCounts(deps, tenantFrom(tenant), params.stocktakeId, body),
  );
  mountRoute(router, r.postStocktake, ({ params, body }, { tenant }) =>
    stock.postStocktake(deps, tenantFrom(tenant), params.stocktakeId, body),
  );
  mountRoute(router, r.cancelStocktake, ({ params }) =>
    stock.cancelStocktake(deps, params.stocktakeId),
  );
  return router;
}
