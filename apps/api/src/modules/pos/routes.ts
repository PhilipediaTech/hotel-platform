import { KITCHEN_ROUTES, POS_REGISTER_ROUTES, POS_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as kitchen from './kitchen.ts';
import * as reg from './register.ts';
import * as setup from './setup.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/**
 * Lite POS: outlets and menus (M8-01; T-141), the register (M8-02, M8-03, M8-05; T-142), the
 * kitchen display (M8-06; T-156).
 */
export function posRoutes(deps: reg.RegisterDeps): Router {
  const router = express.Router();
  const r = POS_ROUTES;
  const k = KITCHEN_ROUTES;
  mountRoute(router, k.getKitchenBoard, ({ query }) => kitchen.getKitchenBoard(deps, query));
  mountRoute(router, k.bumpKitchenTicket, ({ params }, { tenant }) =>
    kitchen.bumpKitchenTicket(deps, tenantFrom(tenant), params.ticketId),
  );
  mountRoute(router, k.recallKitchenTicket, ({ params }, { tenant }) =>
    kitchen.recallKitchenTicket(deps, tenantFrom(tenant), params.ticketId),
  );
  mountRoute(router, r.listOutlets, (_in, { tenant }) =>
    setup.listOutlets(deps, tenantFrom(tenant)),
  );
  mountRoute(router, r.createOutlet, ({ body }) => setup.createOutlet(deps, body));
  mountRoute(router, r.updateOutlet, ({ params, body }) =>
    setup.updateOutlet(deps, params.outletId, body),
  );
  mountRoute(router, r.addMenuCategory, ({ params, body }) =>
    setup.addMenuCategory(deps, params.outletId, body),
  );
  mountRoute(router, r.updateMenuCategory, ({ params, body }) =>
    setup.updateMenuCategory(deps, params.categoryId, body),
  );
  mountRoute(router, r.addMenuItem, ({ params, body }) =>
    setup.addMenuItem(deps, params.categoryId, body),
  );
  mountRoute(router, r.updateMenuItem, ({ params, body }) =>
    setup.updateMenuItem(deps, params.itemId, body),
  );
  mountRoute(router, r.addMenuModifier, ({ params, body }) =>
    setup.addMenuModifier(deps, params.itemId, body),
  );
  mountRoute(router, r.updateMenuModifier, ({ params, body }) =>
    setup.updateMenuModifier(deps, params.modifierId, body),
  );
  const p = POS_REGISTER_ROUTES;
  mountRoute(router, p.getPosRegister, (_in, { tenant }) => reg.register(deps, tenantFrom(tenant)));
  mountRoute(router, p.openOutletShift, ({ body }, { tenant }) =>
    reg.openOutletShift(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, p.closeOutletShift, ({ params, body }, { tenant }) =>
    reg.closeOutletShift(deps, tenantFrom(tenant), params.shiftId, body),
  );
  mountRoute(router, p.addOutletVarianceNote, ({ params, body }, { tenant }) =>
    reg.addOutletVarianceNote(deps, tenantFrom(tenant), params.shiftId, body.note),
  );
  mountRoute(router, p.getOutletMenu, ({ query }, { tenant }) =>
    reg.outletMenu(deps, tenantFrom(tenant), query.outletId),
  );
  mountRoute(router, p.listPosOrders, ({ query }, { tenant }) =>
    reg.listOrders(deps, tenantFrom(tenant), query),
  );
  mountRoute(router, p.getPosOrder, ({ params }) => reg.getOrder(deps, params.orderId));
  mountRoute(router, p.openPosOrder, ({ body }, { tenant }) =>
    reg.openOrder(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, p.addPosOrderLine, ({ params, body }, { tenant }) =>
    reg.addLine(deps, tenantFrom(tenant), params.orderId, body),
  );
  mountRoute(router, p.settlePosOrder, ({ params, body }, { tenant }) =>
    reg.settleOrder(deps, tenantFrom(tenant), params.orderId, body),
  );
  mountRoute(router, p.chargePosOrderToRoom, ({ params, body }, { tenant }) =>
    reg.chargeToRoom(deps, tenantFrom(tenant), params.orderId, body),
  );
  mountRoute(router, p.sendPosOrderToKitchen, ({ params }, { tenant }) =>
    reg.sendToKitchen(deps, tenantFrom(tenant), params.orderId),
  );
  mountRoute(router, p.cancelPosOrder, ({ params }, { tenant }) =>
    reg.cancelOrder(deps, tenantFrom(tenant), params.orderId),
  );
  mountRoute(router, p.voidPosOrderLine, ({ params, body }, { tenant }) =>
    reg.voidLine(deps, tenantFrom(tenant), params.orderId, params.lineId, body),
  );
  mountRoute(router, p.discountPosOrderLine, ({ params, body }, { tenant }) =>
    reg.discountLine(deps, tenantFrom(tenant), params.orderId, params.lineId, body),
  );
  mountRoute(router, p.listPosRooms, () => reg.listRooms(deps));
  mountRoute(router, p.getPosSettings, (_in, { tenant }) =>
    reg.getSettings(deps, tenantFrom(tenant)),
  );
  mountRoute(router, p.updatePosSettings, ({ body }, { tenant }) =>
    reg.updateSettings(deps, tenantFrom(tenant), body),
  );
  return router;
}
