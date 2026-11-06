import { TASK_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as qr from './qr.ts';
import * as tasks from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Tasks, templates and QR fault reports (tab 4 row "Tasks"; T-082). */
export function taskRoutes(deps: tasks.TaskDeps): Router {
  const router = express.Router();
  const r = TASK_ROUTES;

  mountRoute(router, r.listTasks, ({ query }, { tenant }) =>
    tasks.listTasks(deps, tenantFrom(tenant), query),
  );
  mountRoute(router, r.createTask, ({ body }, { tenant }) =>
    tasks.createTask(deps, tenantFrom(tenant), body),
  );
  // Before /tasks/{taskId}, which would read "form-options" as an ID.
  mountRoute(router, r.getTaskFormOptions, (_input, { tenant }) =>
    tasks.formOptions(deps, tenantFrom(tenant)),
  );
  mountRoute(router, r.getTask, ({ params }, { tenant }) =>
    tasks.getTask(deps, tenantFrom(tenant), params.taskId),
  );
  mountRoute(router, r.assignTask, ({ params, body }, { tenant }) =>
    tasks.assignTask(deps, tenantFrom(tenant), params.taskId, body),
  );
  mountRoute(router, r.acknowledgeTask, ({ params }, { tenant }) =>
    tasks.acknowledgeTask(deps, tenantFrom(tenant), params.taskId),
  );
  mountRoute(router, r.startTask, ({ params }, { tenant }) =>
    tasks.startTask(deps, tenantFrom(tenant), params.taskId),
  );
  mountRoute(router, r.holdTask, ({ params, body }, { tenant }) =>
    tasks.holdTask(deps, tenantFrom(tenant), params.taskId, body.reason),
  );
  mountRoute(router, r.resolveTask, ({ params, body }, { tenant }) =>
    tasks.resolveTask(deps, tenantFrom(tenant), params.taskId, body),
  );
  mountRoute(router, r.verifyTask, ({ params, body }, { tenant }) =>
    tasks.verifyTask(deps, tenantFrom(tenant), params.taskId, body.note),
  );
  mountRoute(router, r.reopenTask, ({ params, body }, { tenant }) =>
    tasks.reopenTask(deps, tenantFrom(tenant), params.taskId, body),
  );
  mountRoute(router, r.addTaskComment, ({ params, body }, { tenant }) =>
    tasks.addComment(deps, tenantFrom(tenant), params.taskId, body),
  );
  mountRoute(router, r.listTaskTemplates, (_input, { tenant }) =>
    tasks.listTemplates(deps, tenantFrom(tenant)),
  );
  mountRoute(router, r.createTaskTemplate, ({ body }) => tasks.createTemplate(deps, body));
  mountRoute(router, r.getQrRoom, ({ params }, { tenant }) =>
    qr.getQrRoom(deps, tenantFrom(tenant), params.token),
  );
  mountRoute(router, r.reportQrFault, ({ params, body }, { tenant }) =>
    qr.reportQrFault(deps, tenantFrom(tenant), params.token, body),
  );

  return router;
}
