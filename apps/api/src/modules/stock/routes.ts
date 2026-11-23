import { PURCHASING_ROUTES, STOCK_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as purchasing from './purchasing.ts';
import * as stock from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/**
 * Inventory: items, movements, requisitions and stocktakes (M10-01, M10-02, M10-05; T-145);
 * suppliers, purchase orders and goods receipts (M10-03, M10-04; T-146).
 */
export function stockRoutes(deps: purchasing.PurchasingDeps): Router {
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
  const p = PURCHASING_ROUTES;
  mountRoute(router, p.listSuppliers, () => purchasing.listSuppliers(deps));
  mountRoute(router, p.createSupplier, ({ body }) => purchasing.createSupplier(deps, body));
  mountRoute(router, p.updateSupplier, ({ params, body }) =>
    purchasing.updateSupplier(deps, params.supplierId, body),
  );
  mountRoute(router, p.listPurchaseOrders, ({ query }, { tenant }) =>
    purchasing.listPurchaseOrders(deps, tenantFrom(tenant), query),
  );
  mountRoute(router, p.createPurchaseOrder, ({ body }, { tenant }) =>
    purchasing.createPurchaseOrder(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, p.getPurchaseOrder, ({ params }) =>
    purchasing.getPurchaseOrder(deps, params.orderId),
  );
  mountRoute(router, p.updatePurchaseOrder, ({ params, body }) =>
    purchasing.updatePurchaseOrder(deps, params.orderId, body),
  );
  mountRoute(router, p.approvePurchaseOrder, ({ params, body }, { tenant }) =>
    purchasing.approvePurchaseOrder(deps, tenantFrom(tenant), params.orderId, body),
  );
  mountRoute(router, p.closePurchaseOrder, ({ params, body }, { tenant }) =>
    purchasing.closePurchaseOrder(deps, tenantFrom(tenant), params.orderId, body),
  );
  mountRoute(router, p.cancelPurchaseOrder, ({ params }, { tenant }) =>
    purchasing.cancelPurchaseOrder(deps, tenantFrom(tenant), params.orderId),
  );
  mountRoute(router, p.listGoodsReceipts, () => purchasing.listGoodsReceipts(deps));
  mountRoute(router, p.receiveGoods, ({ body }, { tenant }) =>
    purchasing.receiveGoods(deps, tenantFrom(tenant), body),
  );
  return router;
}
