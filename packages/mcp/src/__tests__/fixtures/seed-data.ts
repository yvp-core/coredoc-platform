/**
 * Realistic Multi-Repo Test Seed Data
 *
 * Creates 3 repositories with ~120 functions total for testing:
 * - Pagination behavior when multiple items match
 * - Cross-repo communication queries
 * - Deep call chains with multiple DB operations
 */

import { EdgeType, NodeType } from '@coredoc/db/types';
import type { GraphNode, GraphEdge } from '@coredoc/db/types';

// =============================================================================
// Repository Hashes (12 chars each)
// =============================================================================

export const REPO_HASHES = {
  userService: 'usrsvc123456',
  orderService: 'ordsvc789012',
  analyticsService: 'anlsvc345678',
} as const;

export const REPO_NAMES = {
  [REPO_HASHES.userService]: 'user-service',
  [REPO_HASHES.orderService]: 'order-service',
  [REPO_HASHES.analyticsService]: 'analytics-service',
} as const;

// =============================================================================
// Helper Functions for Node Creation
// =============================================================================

interface FunctionOpts {
  kind?: 'function' | 'method';
  isAsync?: boolean;
  classId?: string;
  visibility?: 'public' | 'private' | 'protected';
  summary?: string;
}

export function createFunctionNode(
  repoHash: string,
  filePath: string,
  name: string,
  startLine: number,
  opts: FunctionOpts = {},
): GraphNode {
  return {
    id: `${repoHash}:function:${filePath}:${name}`,
    type: NodeType.Function,
    name,
    summary: opts.summary ?? `${name} function`,
    properties: {
      kind: opts.kind ?? 'function',
      isAsync: opts.isAsync ?? false,
      classId: opts.classId,
      visibility: opts.visibility ?? 'public',
    },
    repoId: repoHash,
    filePath,
    startLine,
    endLine: startLine + 15,
  };
}

interface ClassOpts {
  isExported?: boolean;
  isAbstract?: boolean;
}

export function createClassNode(
  repoHash: string,
  filePath: string,
  name: string,
  startLine: number,
  opts: ClassOpts = {},
): GraphNode {
  return {
    id: `${repoHash}:class:${filePath}:${name}`,
    type: NodeType.Class,
    name,
    properties: {
      isExported: opts.isExported ?? true,
      isAbstract: opts.isAbstract ?? false,
    },
    repoId: repoHash,
    filePath,
    startLine,
    endLine: startLine + 100,
  };
}

export function createEntityNode(
  repoHash: string,
  filePath: string,
  name: string,
  tableName: string,
  ormType: string = 'TypeORM',
): GraphNode {
  return {
    id: `${repoHash}:entity:${filePath}:${name}`,
    type: NodeType.Entity,
    name,
    properties: {
      tableName,
      ormType,
    },
    repoId: repoHash,
    filePath,
    startLine: 1,
    endLine: 50,
  };
}

interface EntrypointOpts {
  method?: string;
  path?: string;
  topic?: string;
  schedule?: string;
}

export function createEntrypointNode(
  repoHash: string,
  filePath: string,
  type: 'http' | 'queue' | 'graphql' | 'cron',
  handlerId: string,
  opts: EntrypointOpts = {},
): GraphNode {
  const name =
    type === 'http'
      ? `${opts.method} ${opts.path}`
      : type === 'queue'
        ? `kafka:${opts.topic}`
        : type === 'cron'
          ? `cron:${opts.schedule}`
          : `graphql:${opts.path}`;

  return {
    id: `${repoHash}:entrypoint:${filePath}:${name}`,
    type: NodeType.Entrypoint,
    name,
    properties: {
      entrypointType: type,
      method: opts.method,
      path: opts.path,
      fullPath: opts.path ? `/api${opts.path}` : undefined,
      handlerId,
      topic: opts.topic,
      schedule: opts.schedule,
    },
    repoId: repoHash,
    filePath,
    startLine: 1,
  };
}

export function createFileNode(repoHash: string, filePath: string): GraphNode {
  return {
    id: `${repoHash}:file:${filePath}`,
    type: NodeType.File,
    name: filePath,
    properties: {
      path: filePath,
      extension: filePath.substring(filePath.lastIndexOf('.')),
    },
    repoId: repoHash,
    filePath,
  };
}

export function createRepoNode(repoHash: string, name: string, type: string = 'backend'): GraphNode {
  return {
    id: repoHash,
    type: NodeType.Repository,
    name,
    properties: {
      type,
      parsedAt: new Date().toISOString(),
    },
  };
}

// =============================================================================
// Helper Functions for Edge Creation
// =============================================================================

let edgeCounter = 0;

export function createCallEdge(
  sourceId: string,
  targetId: string,
  opts: { line?: number; isAsync?: boolean } = {},
): GraphEdge {
  return {
    id: `edge:calls:${++edgeCounter}`,
    sourceId,
    targetId,
    type: EdgeType.Calls,
    confidence: 1.0,
    createdBy: 'parser',
    properties: {
      line: opts.line ?? 10,
      isAsync: opts.isAsync ?? false,
    },
  };
}

/**
 * Create an ExternalCall node representing a cross-service call.
 */
export function createExternalCallNode(
  repoHash: string,
  callerId: string,
  serviceName: string,
  protocol: 'http' | 'messaging' | 'grpc' | 'graphql' | 'internal',
  opts: {
    method?: string;
    httpMethod?: string;
    pathTemplate?: string;
    messagingSystem?: string;
    messagingDestination?: string;
    grpcService?: string;
    grpcMethod?: string;
    filePath?: string;
    startLine?: number;
    /** Entrypoint this call was resolved to by the cross-repo linker. */
    resolvedTargetId?: string;
  } = {},
): GraphNode {
  const method = opts.method || opts.messagingDestination || opts.grpcMethod || 'call';
  const callPattern =
    protocol === 'messaging'
      ? opts.messagingDestination
      : protocol === 'http'
        ? `${opts.httpMethod || 'GET'} ${opts.pathTemplate || '/'}`
        : protocol === 'grpc'
          ? `${opts.grpcService}.${opts.grpcMethod}`
          : method;

  return {
    id: `${repoHash}:external_call:${serviceName}:${++edgeCounter}`,
    type: NodeType.ExternalCall,
    name: `${serviceName}:${callPattern}`,
    properties: {
      callerId,
      serviceName,
      protocol,
      method,
      httpMethod: opts.httpMethod,
      pathTemplate: opts.pathTemplate,
      messagingSystem: opts.messagingSystem,
      messagingDestination: opts.messagingDestination,
      messagingDestinationRef: opts.messagingDestination,
      grpcService: opts.grpcService,
      grpcMethod: opts.grpcMethod,
      resolvedTargetId: opts.resolvedTargetId,
    },
    repoId: repoHash,
    filePath: opts.filePath || '',
    startLine: opts.startLine || 0,
  };
}

/**
 * Create a MAKES_EXTERNAL_CALL edge linking a function to an ExternalCall node.
 */
export function createMakesExternalCallEdge(callerId: string, externalCallId: string): GraphEdge {
  return {
    id: `edge:makes_external_call:${++edgeCounter}`,
    sourceId: callerId,
    targetId: externalCallId,
    type: EdgeType.MakesExternalCall,
    confidence: 1.0,
    createdBy: 'parser',
    properties: {},
  };
}

export function createExtendsEdge(childClassId: string, parentClassId: string): GraphEdge {
  return {
    id: `edge:extends:${++edgeCounter}`,
    sourceId: childClassId,
    targetId: parentClassId,
    type: EdgeType.Extends,
    confidence: 1.0,
    createdBy: 'parser',
    properties: {},
  };
}

export function createImplementsEdge(classId: string, interfaceId: string): GraphEdge {
  return {
    id: `edge:implements:${++edgeCounter}`,
    sourceId: classId,
    targetId: interfaceId,
    type: EdgeType.ImplementsInterface,
    confidence: 1.0,
    createdBy: 'parser',
    properties: {},
  };
}

export function createInterfaceNode(repoHash: string, filePath: string, name: string, startLine: number): GraphNode {
  return {
    id: `${repoHash}:interface:${filePath}:${name}`,
    type: NodeType.Interface,
    name,
    properties: {
      isExported: true,
    },
    repoId: repoHash,
    filePath,
    startLine,
    endLine: startLine + 20,
  };
}

export function createHasMethodEdge(classId: string, methodId: string): GraphEdge {
  return {
    id: `edge:has_method:${++edgeCounter}`,
    sourceId: classId,
    targetId: methodId,
    type: EdgeType.HasMethod,
    confidence: 1.0,
    createdBy: 'parser',
    properties: {},
  };
}

export function createHandlesEdge(entrypointId: string, handlerId: string): GraphEdge {
  return {
    id: `edge:handles:${++edgeCounter}`,
    sourceId: entrypointId,
    targetId: handlerId,
    type: EdgeType.Handles,
    confidence: 1.0,
    createdBy: 'parser',
    properties: {},
  };
}

export function createOperatesOnEdge(
  functionId: string,
  entityId: string,
  operation: 'create' | 'read' | 'update' | 'delete',
): GraphEdge {
  return {
    id: `edge:operates:${++edgeCounter}`,
    sourceId: functionId,
    targetId: entityId,
    type: EdgeType.OperatesOn,
    confidence: 1.0,
    createdBy: 'parser',
    properties: { operation },
  };
}

// =============================================================================
// User Service (45 functions)
// =============================================================================

function createUserServiceData(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const h = REPO_HASHES.userService;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // Repository
  nodes.push(createRepoNode(h, 'user-service', 'backend'));

  // Files
  const files = [
    'src/controllers/user.controller.ts',
    'src/services/user.service.ts',
    'src/validators/user.validator.ts',
    'src/repositories/user.repository.ts',
    'src/entities/user.entity.ts',
    'src/entities/profile.entity.ts',
    'src/entities/user-settings.entity.ts',
  ];
  files.forEach((f) => nodes.push(createFileNode(h, f)));

  // Classes
  const userController = createClassNode(h, 'src/controllers/user.controller.ts', 'UserController', 10);
  const userService = createClassNode(h, 'src/services/user.service.ts', 'UserService', 10);
  const userValidator = createClassNode(h, 'src/validators/user.validator.ts', 'UserValidator', 10);
  const userRepository = createClassNode(h, 'src/repositories/user.repository.ts', 'UserRepository', 10);

  // Base class and child classes for testing get_dependents
  const baseService = createClassNode(h, 'src/services/base.service.ts', 'BaseService', 10, { isAbstract: true });

  // Client classes for testing get_service_dependencies
  const orderClient = createClassNode(h, 'src/clients/order.client.ts', 'OrderClient', 10);
  const paymentClient = createClassNode(h, 'src/clients/payment.client.ts', 'PaymentClient', 10);
  const userEventProducer = createClassNode(h, 'src/producers/user-event.producer.ts', 'UserEventProducer', 10);

  // Interface for testing get_dependents with interface implementations
  const serviceInterface = createInterfaceNode(h, 'src/interfaces/service.interface.ts', 'IService', 10);

  nodes.push(userController, userService, userValidator, userRepository);
  nodes.push(baseService, orderClient, paymentClient, userEventProducer);
  nodes.push(serviceInterface);

  // Files for new classes
  nodes.push(createFileNode(h, 'src/services/base.service.ts'));
  nodes.push(createFileNode(h, 'src/clients/order.client.ts'));
  nodes.push(createFileNode(h, 'src/clients/payment.client.ts'));
  nodes.push(createFileNode(h, 'src/producers/user-event.producer.ts'));
  nodes.push(createFileNode(h, 'src/interfaces/service.interface.ts'));

  // EXTENDS edges: UserService extends BaseService
  edges.push(createExtendsEdge(userService.id, baseService.id));

  // IMPLEMENTS edges: UserService implements IService
  edges.push(createImplementsEdge(userService.id, serviceInterface.id));

  // Entities
  const userEntity = createEntityNode(h, 'src/entities/user.entity.ts', 'User', 'users');
  const profileEntity = createEntityNode(h, 'src/entities/profile.entity.ts', 'Profile', 'profiles');
  const settingsEntity = createEntityNode(h, 'src/entities/user-settings.entity.ts', 'UserSettings', 'user_settings');
  nodes.push(userEntity, profileEntity, settingsEntity);

  // Controllers (8 functions)
  const controllerFuncs = [
    'createUser',
    'getUser',
    'updateUser',
    'deleteUser',
    'listUsers',
    'getUserProfile',
    'updateProfile',
    'changePassword',
  ];
  const controllerNodes = controllerFuncs.map((name, i) =>
    createFunctionNode(h, 'src/controllers/user.controller.ts', name, 20 + i * 20, {
      kind: 'method',
      isAsync: true,
      classId: userController.id,
      summary: `HTTP handler for ${name}`,
    }),
  );
  nodes.push(...controllerNodes);
  controllerNodes.forEach((n) => edges.push(createHasMethodEdge(userController.id, n.id)));

  // Services (20 functions)
  const serviceFuncs = [
    'validateUser',
    'hashPassword',
    'generateToken',
    'verifyToken',
    'sendWelcomeEmail',
    'createAuditLog',
    'getUserById',
    'getUserByEmail',
    'updateUserSettings',
    'deactivateUser',
    'reactivateUser',
    'syncUserData',
    'processUserEvent',
    'notifyUserChange',
    'validateEmail',
    'validatePhone',
    'formatUserResponse',
    'enrichUserData',
    'calculateUserScore',
    'checkUserPermissions',
  ];
  const serviceNodes = serviceFuncs.map((name, i) =>
    createFunctionNode(h, 'src/services/user.service.ts', name, 20 + i * 15, {
      kind: 'method',
      isAsync: ['sendWelcomeEmail', 'syncUserData', 'notifyUserChange', 'getUserById', 'getUserByEmail'].includes(name),
      classId: userService.id,
      summary: `${name} service method`,
    }),
  );
  nodes.push(...serviceNodes);
  serviceNodes.forEach((n) => edges.push(createHasMethodEdge(userService.id, n.id)));

  // Validators (8 functions)
  const validatorFuncs = [
    'validateCreateUserInput',
    'validateUpdateUserInput',
    'validatePasswordStrength',
    'validateEmailFormat',
    'validatePhoneFormat',
    'validateProfileData',
    'validateSettingsData',
    'validatePermissions',
  ];
  const validatorNodes = validatorFuncs.map((name, i) =>
    createFunctionNode(h, 'src/validators/user.validator.ts', name, 10 + i * 20, {
      kind: 'function',
      isAsync: false,
      summary: `Validates ${name.replace('validate', '').replace('Input', '')}`,
    }),
  );
  nodes.push(...validatorNodes);

  // Repository (9 functions)
  const repoFuncs = [
    'findUserById',
    'findUserByEmail',
    'saveUser',
    'updateUserRecord',
    'deleteUserRecord',
    'findUsersByFilter',
    'countUsers',
    'findUserProfile',
    'saveUserProfile',
  ];
  const repoNodes = repoFuncs.map((name, i) =>
    createFunctionNode(h, 'src/repositories/user.repository.ts', name, 10 + i * 15, {
      kind: 'method',
      isAsync: true,
      classId: userRepository.id,
      summary: `Database operation: ${name}`,
    }),
  );
  nodes.push(...repoNodes);
  repoNodes.forEach((n) => edges.push(createHasMethodEdge(userRepository.id, n.id)));

  // Entrypoints (8 HTTP + 2 Kafka)
  const httpEntrypoints = [
    { method: 'POST', path: '/users', handler: 'createUser' },
    { method: 'GET', path: '/users/:id', handler: 'getUser' },
    { method: 'PUT', path: '/users/:id', handler: 'updateUser' },
    { method: 'DELETE', path: '/users/:id', handler: 'deleteUser' },
    { method: 'GET', path: '/users', handler: 'listUsers' },
    { method: 'GET', path: '/users/:id/profile', handler: 'getUserProfile' },
    { method: 'PUT', path: '/users/:id/profile', handler: 'updateProfile' },
    { method: 'POST', path: '/users/:id/password', handler: 'changePassword' },
  ];
  httpEntrypoints.forEach((ep) => {
    const handlerId = `${h}:function:src/controllers/user.controller.ts:${ep.handler}`;
    const entrypoint = createEntrypointNode(h, 'src/controllers/user.controller.ts', 'http', handlerId, {
      method: ep.method,
      path: ep.path,
    });
    nodes.push(entrypoint);
    edges.push(createHandlesEdge(entrypoint.id, handlerId));
  });

  // Kafka entrypoints
  const kafkaEntrypoints = [
    { topic: 'user.created', handler: 'processUserEvent' },
    { topic: 'user.updated', handler: 'processUserEvent' },
  ];
  kafkaEntrypoints.forEach((ep) => {
    const handlerId = `${h}:function:src/services/user.service.ts:${ep.handler}`;
    const entrypoint = createEntrypointNode(h, 'src/services/user.service.ts', 'queue', handlerId, {
      topic: ep.topic,
    });
    nodes.push(entrypoint);
    edges.push(createHandlesEdge(entrypoint.id, handlerId));
  });

  // ==== CALL CHAINS ====
  // Deep chain: createUser → validateCreateUserInput → validateEmail → formatUserResponse
  //                       ↓
  //             hashPassword → generateToken
  //                       ↓
  //             saveUser → createAuditLog → notifyUserChange (EXTERNAL: OrderService)
  const createUserId = `${h}:function:src/controllers/user.controller.ts:createUser`;
  const validateUserSvc = `${h}:function:src/services/user.service.ts:validateUser`;
  const validateCreateInput = `${h}:function:src/validators/user.validator.ts:validateCreateUserInput`;
  const validateEmailFormat = `${h}:function:src/validators/user.validator.ts:validateEmailFormat`;
  const hashPasswordId = `${h}:function:src/services/user.service.ts:hashPassword`;
  const generateTokenId = `${h}:function:src/services/user.service.ts:generateToken`;
  const saveUserId = `${h}:function:src/repositories/user.repository.ts:saveUser`;
  const createAuditLogId = `${h}:function:src/services/user.service.ts:createAuditLog`;
  const notifyUserChangeId = `${h}:function:src/services/user.service.ts:notifyUserChange`;
  const formatUserResponseId = `${h}:function:src/services/user.service.ts:formatUserResponse`;
  const syncUserDataId = `${h}:function:src/services/user.service.ts:syncUserData`;

  edges.push(createCallEdge(createUserId, validateUserSvc, { line: 25, isAsync: false }));
  edges.push(createCallEdge(validateUserSvc, validateCreateInput, { line: 30 }));
  edges.push(createCallEdge(validateCreateInput, validateEmailFormat, { line: 15 }));
  edges.push(createCallEdge(createUserId, hashPasswordId, { line: 28, isAsync: true }));
  edges.push(createCallEdge(hashPasswordId, generateTokenId, { line: 50 }));
  edges.push(createCallEdge(createUserId, saveUserId, { line: 35, isAsync: true }));
  edges.push(createCallEdge(saveUserId, createAuditLogId, { line: 20, isAsync: true }));
  edges.push(createCallEdge(createAuditLogId, notifyUserChangeId, { line: 25, isAsync: true }));
  edges.push(createCallEdge(createUserId, formatUserResponseId, { line: 40 }));

  // External call to order-service - create nodes and edges
  const extCall1 = createExternalCallNode(h, notifyUserChangeId, 'order-service', 'messaging', {
    messagingSystem: 'kafka',
    messagingDestination: 'user.changed',
    method: 'publish',
    filePath: 'src/services/user.service.ts',
    startLine: 150,
  });
  nodes.push(extCall1);
  edges.push(createMakesExternalCallEdge(notifyUserChangeId, extCall1.id));

  const extCall2 = createExternalCallNode(h, syncUserDataId, 'order-service', 'http', {
    httpMethod: 'GET',
    pathTemplate: '/api/orders/user/:id',
    method: 'getOrdersForUser',
    filePath: 'src/services/user.service.ts',
    startLine: 200,
  });
  nodes.push(extCall2);
  edges.push(createMakesExternalCallEdge(syncUserDataId, extCall2.id));

  // ==== ENTITY OPERATIONS ====
  // User entity: create, read, update, delete
  edges.push(
    createOperatesOnEdge(`${h}:function:src/controllers/user.controller.ts:createUser`, userEntity.id, 'create'),
  );
  edges.push(createOperatesOnEdge(saveUserId, userEntity.id, 'create'));
  edges.push(
    createOperatesOnEdge(`${h}:function:src/repositories/user.repository.ts:findUserById`, userEntity.id, 'read'),
  );
  edges.push(
    createOperatesOnEdge(`${h}:function:src/repositories/user.repository.ts:findUserByEmail`, userEntity.id, 'read'),
  );
  edges.push(createOperatesOnEdge(`${h}:function:src/services/user.service.ts:getUserById`, userEntity.id, 'read'));
  edges.push(createOperatesOnEdge(`${h}:function:src/services/user.service.ts:getUserByEmail`, userEntity.id, 'read'));
  edges.push(createOperatesOnEdge(`${h}:function:src/controllers/user.controller.ts:getUser`, userEntity.id, 'read'));
  edges.push(
    createOperatesOnEdge(`${h}:function:src/repositories/user.repository.ts:updateUserRecord`, userEntity.id, 'update'),
  );
  edges.push(
    createOperatesOnEdge(`${h}:function:src/controllers/user.controller.ts:updateUser`, userEntity.id, 'update'),
  );
  edges.push(
    createOperatesOnEdge(`${h}:function:src/repositories/user.repository.ts:deleteUserRecord`, userEntity.id, 'delete'),
  );
  edges.push(
    createOperatesOnEdge(`${h}:function:src/controllers/user.controller.ts:deleteUser`, userEntity.id, 'delete'),
  );

  // Profile entity
  edges.push(
    createOperatesOnEdge(`${h}:function:src/controllers/user.controller.ts:getUserProfile`, profileEntity.id, 'read'),
  );
  edges.push(
    createOperatesOnEdge(`${h}:function:src/repositories/user.repository.ts:findUserProfile`, profileEntity.id, 'read'),
  );
  edges.push(
    createOperatesOnEdge(`${h}:function:src/controllers/user.controller.ts:updateProfile`, profileEntity.id, 'update'),
  );
  edges.push(
    createOperatesOnEdge(
      `${h}:function:src/repositories/user.repository.ts:saveUserProfile`,
      profileEntity.id,
      'update',
    ),
  );

  return { nodes, edges };
}

// =============================================================================
// Order Service (40 functions)
// =============================================================================

function createOrderServiceData(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const h = REPO_HASHES.orderService;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // Repository
  nodes.push(createRepoNode(h, 'order-service', 'backend'));

  // Files
  const files = [
    'src/controllers/order.controller.ts',
    'src/services/order.service.ts',
    'src/validators/order.validator.ts',
    'src/repositories/order.repository.ts',
    'src/entities/order.entity.ts',
    'src/entities/order-item.entity.ts',
    'src/entities/invoice.entity.ts',
    'src/entities/payment.entity.ts',
  ];
  files.forEach((f) => nodes.push(createFileNode(h, f)));

  // Classes
  const orderController = createClassNode(h, 'src/controllers/order.controller.ts', 'OrderController', 10);
  const orderService = createClassNode(h, 'src/services/order.service.ts', 'OrderService', 10);
  const orderValidator = createClassNode(h, 'src/validators/order.validator.ts', 'OrderValidator', 10);
  const orderRepository = createClassNode(h, 'src/repositories/order.repository.ts', 'OrderRepository', 10);
  nodes.push(orderController, orderService, orderValidator, orderRepository);

  // Entities
  const orderEntity = createEntityNode(h, 'src/entities/order.entity.ts', 'Order', 'orders');
  const orderItemEntity = createEntityNode(h, 'src/entities/order-item.entity.ts', 'OrderItem', 'order_items');
  const invoiceEntity = createEntityNode(h, 'src/entities/invoice.entity.ts', 'Invoice', 'invoices');
  const paymentEntity = createEntityNode(h, 'src/entities/payment.entity.ts', 'Payment', 'payments');
  nodes.push(orderEntity, orderItemEntity, invoiceEntity, paymentEntity);

  // Controllers (6 functions)
  const controllerFuncs = ['createOrder', 'getOrder', 'updateOrder', 'cancelOrder', 'listOrders', 'processPayment'];
  const controllerNodes = controllerFuncs.map((name, i) =>
    createFunctionNode(h, 'src/controllers/order.controller.ts', name, 20 + i * 25, {
      kind: 'method',
      isAsync: true,
      classId: orderController.id,
      summary: `HTTP handler for ${name}`,
    }),
  );
  nodes.push(...controllerNodes);
  controllerNodes.forEach((n) => edges.push(createHasMethodEdge(orderController.id, n.id)));

  // Services (18 functions)
  const serviceFuncs = [
    'validateOrder',
    'calculateTotal',
    'applyDiscount',
    'checkInventory',
    'reserveStock',
    'processOrderCreated',
    'sendOrderConfirmation',
    'createInvoice',
    'processRefund',
    'calculateTax',
    'validatePayment',
    'processPaymentResult',
    'notifyOrderStatus',
    'enrichOrderData',
    'validateShipping',
    'calculateShipping',
    'archiveOrder',
    'getOrderHistory',
  ];
  const serviceNodes = serviceFuncs.map((name, i) =>
    createFunctionNode(h, 'src/services/order.service.ts', name, 20 + i * 15, {
      kind: 'method',
      isAsync: [
        'sendOrderConfirmation',
        'checkInventory',
        'reserveStock',
        'processOrderCreated',
        'createInvoice',
      ].includes(name),
      classId: orderService.id,
      summary: `${name} service method`,
    }),
  );
  nodes.push(...serviceNodes);
  serviceNodes.forEach((n) => edges.push(createHasMethodEdge(orderService.id, n.id)));

  // Validators (6 functions)
  const validatorFuncs = [
    'validateCreateOrderInput',
    'validateOrderItems',
    'validateShippingAddress',
    'validatePaymentMethod',
    'validateDiscountCode',
    'validateOrderStatus',
  ];
  const validatorNodes = validatorFuncs.map((name, i) =>
    createFunctionNode(h, 'src/validators/order.validator.ts', name, 10 + i * 20, {
      kind: 'function',
      isAsync: false,
      summary: `Validates ${name.replace('validate', '')}`,
    }),
  );
  nodes.push(...validatorNodes);

  // Repository (10 functions)
  const repoFuncs = [
    'findOrderById',
    'saveOrder',
    'updateOrderRecord',
    'findOrdersByUser',
    'countOrdersByUser',
    'findOrderItems',
    'saveOrderItems',
    'findInvoice',
    'saveInvoice',
    'findOrdersByStatus',
  ];
  const repoNodes = repoFuncs.map((name, i) =>
    createFunctionNode(h, 'src/repositories/order.repository.ts', name, 10 + i * 15, {
      kind: 'method',
      isAsync: true,
      classId: orderRepository.id,
      summary: `Database operation: ${name}`,
    }),
  );
  nodes.push(...repoNodes);
  repoNodes.forEach((n) => edges.push(createHasMethodEdge(orderRepository.id, n.id)));

  // Entrypoints (6 HTTP + 2 Kafka)
  const httpEntrypoints = [
    { method: 'POST', path: '/orders', handler: 'createOrder' },
    { method: 'GET', path: '/orders/:id', handler: 'getOrder' },
    { method: 'PUT', path: '/orders/:id', handler: 'updateOrder' },
    { method: 'DELETE', path: '/orders/:id', handler: 'cancelOrder' },
    { method: 'GET', path: '/orders', handler: 'listOrders' },
    { method: 'POST', path: '/orders/:id/payment', handler: 'processPayment' },
  ];
  httpEntrypoints.forEach((ep) => {
    const handlerId = `${h}:function:src/controllers/order.controller.ts:${ep.handler}`;
    const entrypoint = createEntrypointNode(h, 'src/controllers/order.controller.ts', 'http', handlerId, {
      method: ep.method,
      path: ep.path,
    });
    nodes.push(entrypoint);
    edges.push(createHandlesEdge(entrypoint.id, handlerId));
  });

  // Kafka entrypoints
  const kafkaEntrypoints = [
    { topic: 'order.payment.received', handler: 'processPaymentResult' },
    { topic: 'user.changed', handler: 'processOrderCreated' },
  ];
  kafkaEntrypoints.forEach((ep) => {
    const handlerId = `${h}:function:src/services/order.service.ts:${ep.handler}`;
    const entrypoint = createEntrypointNode(h, 'src/services/order.service.ts', 'queue', handlerId, {
      topic: ep.topic,
    });
    nodes.push(entrypoint);
    edges.push(createHandlesEdge(entrypoint.id, handlerId));
  });

  // ==== CALL CHAINS ====
  // Deep chain: createOrder → validateOrder → validateOrderItems → checkInventory
  //                        ↓
  //            calculateTotal → applyDiscount → calculateTax
  //                        ↓
  //            reserveStock → processOrderCreated → sendOrderConfirmation
  //                        ↓
  //            getUserById (EXTERNAL: UserService) → enrichOrderData
  const createOrderId = `${h}:function:src/controllers/order.controller.ts:createOrder`;
  const validateOrderId = `${h}:function:src/services/order.service.ts:validateOrder`;
  const validateOrderItems = `${h}:function:src/validators/order.validator.ts:validateOrderItems`;
  const checkInventoryId = `${h}:function:src/services/order.service.ts:checkInventory`;
  const calculateTotalId = `${h}:function:src/services/order.service.ts:calculateTotal`;
  const applyDiscountId = `${h}:function:src/services/order.service.ts:applyDiscount`;
  const calculateTaxId = `${h}:function:src/services/order.service.ts:calculateTax`;
  const reserveStockId = `${h}:function:src/services/order.service.ts:reserveStock`;
  const processOrderCreatedId = `${h}:function:src/services/order.service.ts:processOrderCreated`;
  const sendOrderConfirmationId = `${h}:function:src/services/order.service.ts:sendOrderConfirmation`;
  const enrichOrderDataId = `${h}:function:src/services/order.service.ts:enrichOrderData`;
  const saveOrderId = `${h}:function:src/repositories/order.repository.ts:saveOrder`;
  const validatePaymentId = `${h}:function:src/services/order.service.ts:validatePayment`;

  edges.push(createCallEdge(createOrderId, validateOrderId, { line: 25 }));
  edges.push(createCallEdge(validateOrderId, validateOrderItems, { line: 30 }));
  edges.push(createCallEdge(validateOrderId, checkInventoryId, { line: 35, isAsync: true }));
  edges.push(createCallEdge(createOrderId, calculateTotalId, { line: 40 }));
  edges.push(createCallEdge(calculateTotalId, applyDiscountId, { line: 25 }));
  edges.push(createCallEdge(calculateTotalId, calculateTaxId, { line: 30 }));
  edges.push(createCallEdge(createOrderId, reserveStockId, { line: 50, isAsync: true }));
  edges.push(createCallEdge(reserveStockId, processOrderCreatedId, { line: 20, isAsync: true }));
  edges.push(createCallEdge(processOrderCreatedId, sendOrderConfirmationId, { line: 25, isAsync: true }));
  edges.push(createCallEdge(processOrderCreatedId, enrichOrderDataId, { line: 30 }));
  edges.push(createCallEdge(createOrderId, saveOrderId, { line: 55, isAsync: true }));

  // External calls to user-service - create nodes and edges
  const extCall3 = createExternalCallNode(h, enrichOrderDataId, 'user-service', 'http', {
    httpMethod: 'GET',
    pathTemplate: '/api/users/:id',
    method: 'getUserById',
    filePath: 'src/services/order.service.ts',
    startLine: 100,
    // The cross-repo linker resolved this one: it is the bridge a
    // trace_cross_repo_call must be able to walk from EITHER end.
    resolvedTargetId: `${REPO_HASHES.userService}:entrypoint:src/controllers/user.controller.ts:GET /users/:id`,
  });
  nodes.push(extCall3);
  edges.push(createMakesExternalCallEdge(enrichOrderDataId, extCall3.id));

  const extCall4 = createExternalCallNode(h, validatePaymentId, 'user-service', 'http', {
    httpMethod: 'GET',
    pathTemplate: '/api/users/:id/payment-methods',
    method: 'getPaymentMethods',
    filePath: 'src/services/order.service.ts',
    startLine: 150,
  });
  nodes.push(extCall4);
  edges.push(createMakesExternalCallEdge(validatePaymentId, extCall4.id));

  // ==== ENTITY OPERATIONS ====
  // Order entity
  edges.push(createOperatesOnEdge(createOrderId, orderEntity.id, 'create'));
  edges.push(createOperatesOnEdge(saveOrderId, orderEntity.id, 'create'));
  edges.push(
    createOperatesOnEdge(`${h}:function:src/repositories/order.repository.ts:findOrderById`, orderEntity.id, 'read'),
  );
  edges.push(
    createOperatesOnEdge(`${h}:function:src/repositories/order.repository.ts:findOrdersByUser`, orderEntity.id, 'read'),
  );
  edges.push(
    createOperatesOnEdge(`${h}:function:src/controllers/order.controller.ts:getOrder`, orderEntity.id, 'read'),
  );
  edges.push(
    createOperatesOnEdge(
      `${h}:function:src/repositories/order.repository.ts:updateOrderRecord`,
      orderEntity.id,
      'update',
    ),
  );
  edges.push(
    createOperatesOnEdge(`${h}:function:src/controllers/order.controller.ts:updateOrder`, orderEntity.id, 'update'),
  );
  edges.push(
    createOperatesOnEdge(`${h}:function:src/controllers/order.controller.ts:cancelOrder`, orderEntity.id, 'delete'),
  );

  // OrderItem entity
  edges.push(createOperatesOnEdge(createOrderId, orderItemEntity.id, 'create'));
  edges.push(
    createOperatesOnEdge(
      `${h}:function:src/repositories/order.repository.ts:saveOrderItems`,
      orderItemEntity.id,
      'create',
    ),
  );
  edges.push(
    createOperatesOnEdge(
      `${h}:function:src/repositories/order.repository.ts:findOrderItems`,
      orderItemEntity.id,
      'read',
    ),
  );
  edges.push(
    createOperatesOnEdge(`${h}:function:src/controllers/order.controller.ts:cancelOrder`, orderItemEntity.id, 'delete'),
  );

  // Invoice entity
  edges.push(
    createOperatesOnEdge(
      `${h}:function:src/controllers/order.controller.ts:processPayment`,
      invoiceEntity.id,
      'create',
    ),
  );
  edges.push(
    createOperatesOnEdge(`${h}:function:src/services/order.service.ts:createInvoice`, invoiceEntity.id, 'create'),
  );
  edges.push(
    createOperatesOnEdge(`${h}:function:src/repositories/order.repository.ts:saveInvoice`, invoiceEntity.id, 'create'),
  );
  edges.push(
    createOperatesOnEdge(`${h}:function:src/repositories/order.repository.ts:findInvoice`, invoiceEntity.id, 'read'),
  );

  return { nodes, edges };
}

// =============================================================================
// Analytics Service (35 functions)
// =============================================================================

function createAnalyticsServiceData(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const h = REPO_HASHES.analyticsService;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // Repository
  nodes.push(createRepoNode(h, 'analytics-service', 'backend'));

  // Files
  const files = [
    'src/controllers/analytics.controller.ts',
    'src/services/analytics.service.ts',
    'src/validators/analytics.validator.ts',
    'src/repositories/analytics.repository.ts',
    'src/entities/metric.entity.ts',
    'src/entities/report.entity.ts',
    'src/entities/dashboard-config.entity.ts',
  ];
  files.forEach((f) => nodes.push(createFileNode(h, f)));

  // Classes
  const analyticsController = createClassNode(h, 'src/controllers/analytics.controller.ts', 'AnalyticsController', 10);
  const analyticsService = createClassNode(h, 'src/services/analytics.service.ts', 'AnalyticsService', 10);
  const analyticsValidator = createClassNode(h, 'src/validators/analytics.validator.ts', 'AnalyticsValidator', 10);
  const analyticsRepository = createClassNode(h, 'src/repositories/analytics.repository.ts', 'AnalyticsRepository', 10);
  nodes.push(analyticsController, analyticsService, analyticsValidator, analyticsRepository);

  // Entities
  const metricEntity = createEntityNode(h, 'src/entities/metric.entity.ts', 'Metric', 'metrics');
  const reportEntity = createEntityNode(h, 'src/entities/report.entity.ts', 'Report', 'reports');
  const dashboardConfigEntity = createEntityNode(
    h,
    'src/entities/dashboard-config.entity.ts',
    'DashboardConfig',
    'dashboard_configs',
  );
  nodes.push(metricEntity, reportEntity, dashboardConfigEntity);

  // Controllers (5 functions)
  const controllerFuncs = ['getDashboard', 'getMetrics', 'getReport', 'exportData', 'scheduleReport'];
  const controllerNodes = controllerFuncs.map((name, i) =>
    createFunctionNode(h, 'src/controllers/analytics.controller.ts', name, 20 + i * 30, {
      kind: 'method',
      isAsync: true,
      classId: analyticsController.id,
      summary: `HTTP handler for ${name}`,
    }),
  );
  nodes.push(...controllerNodes);
  controllerNodes.forEach((n) => edges.push(createHasMethodEdge(analyticsController.id, n.id)));

  // Services (18 functions)
  const serviceFuncs = [
    'aggregateMetrics',
    'calculateKPIs',
    'generateCharts',
    'processTimeSeries',
    'computeAverages',
    'computeTrends',
    'detectAnomalies',
    'forecastValues',
    'buildDashboard',
    'formatReport',
    'compressData',
    'validateDateRange',
    'parseFilters',
    'applyFilters',
    'sortResults',
    'paginateResults',
    'cacheResults',
    'invalidateCache',
  ];
  const serviceNodes = serviceFuncs.map((name, i) =>
    createFunctionNode(h, 'src/services/analytics.service.ts', name, 20 + i * 15, {
      kind: 'method',
      isAsync: ['aggregateMetrics', 'generateCharts', 'forecastValues', 'cacheResults'].includes(name),
      classId: analyticsService.id,
      summary: `${name} service method`,
    }),
  );
  nodes.push(...serviceNodes);
  serviceNodes.forEach((n) => edges.push(createHasMethodEdge(analyticsService.id, n.id)));

  // Validators (4 functions)
  const validatorFuncs = ['validateDateRange', 'validateMetricType', 'validateReportFormat', 'validateExportFormat'];
  const validatorNodes = validatorFuncs.map((name, i) =>
    createFunctionNode(h, 'src/validators/analytics.validator.ts', name, 10 + i * 20, {
      kind: 'function',
      isAsync: false,
      summary: `Validates ${name.replace('validate', '')}`,
    }),
  );
  nodes.push(...validatorNodes);

  // Repository (8 functions)
  const repoFuncs = [
    'findMetricsByRange',
    'aggregateByPeriod',
    'findReportById',
    'saveReport',
    'findDashboardConfig',
    'saveDashboardConfig',
    'findCachedResult',
    'saveCachedResult',
  ];
  const repoNodes = repoFuncs.map((name, i) =>
    createFunctionNode(h, 'src/repositories/analytics.repository.ts', name, 10 + i * 15, {
      kind: 'method',
      isAsync: true,
      classId: analyticsRepository.id,
      summary: `Database operation: ${name}`,
    }),
  );
  nodes.push(...repoNodes);
  repoNodes.forEach((n) => edges.push(createHasMethodEdge(analyticsRepository.id, n.id)));

  // Entrypoints (5 HTTP only)
  const httpEntrypoints = [
    { method: 'GET', path: '/dashboard', handler: 'getDashboard' },
    { method: 'GET', path: '/metrics', handler: 'getMetrics' },
    { method: 'GET', path: '/reports/:id', handler: 'getReport' },
    { method: 'POST', path: '/export', handler: 'exportData' },
    { method: 'POST', path: '/reports/schedule', handler: 'scheduleReport' },
  ];
  httpEntrypoints.forEach((ep) => {
    const handlerId = `${h}:function:src/controllers/analytics.controller.ts:${ep.handler}`;
    const entrypoint = createEntrypointNode(h, 'src/controllers/analytics.controller.ts', 'http', handlerId, {
      method: ep.method,
      path: ep.path,
    });
    nodes.push(entrypoint);
    edges.push(createHandlesEdge(entrypoint.id, handlerId));
  });

  // ==== CALL CHAINS ====
  // Deep chain: getMetrics → validateDateRange → parseFilters → applyFilters
  //                       ↓
  //           aggregateMetrics → computeAverages → computeTrends
  //                       ↓
  //           paginateResults → formatReport → cacheResults
  const getMetricsId = `${h}:function:src/controllers/analytics.controller.ts:getMetrics`;
  const validateDateRangeSvc = `${h}:function:src/services/analytics.service.ts:validateDateRange`;
  const validateDateRangeValidator = `${h}:function:src/validators/analytics.validator.ts:validateDateRange`;
  const parseFiltersId = `${h}:function:src/services/analytics.service.ts:parseFilters`;
  const applyFiltersId = `${h}:function:src/services/analytics.service.ts:applyFilters`;
  const aggregateMetricsId = `${h}:function:src/services/analytics.service.ts:aggregateMetrics`;
  const computeAveragesId = `${h}:function:src/services/analytics.service.ts:computeAverages`;
  const computeTrendsId = `${h}:function:src/services/analytics.service.ts:computeTrends`;
  const paginateResultsId = `${h}:function:src/services/analytics.service.ts:paginateResults`;
  const formatReportId = `${h}:function:src/services/analytics.service.ts:formatReport`;
  const cacheResultsId = `${h}:function:src/services/analytics.service.ts:cacheResults`;
  const findMetricsByRangeId = `${h}:function:src/repositories/analytics.repository.ts:findMetricsByRange`;

  edges.push(createCallEdge(getMetricsId, validateDateRangeSvc, { line: 25 }));
  edges.push(createCallEdge(validateDateRangeSvc, validateDateRangeValidator, { line: 30 }));
  edges.push(createCallEdge(getMetricsId, parseFiltersId, { line: 30 }));
  edges.push(createCallEdge(parseFiltersId, applyFiltersId, { line: 20 }));
  edges.push(createCallEdge(getMetricsId, aggregateMetricsId, { line: 35, isAsync: true }));
  edges.push(createCallEdge(aggregateMetricsId, computeAveragesId, { line: 25 }));
  edges.push(createCallEdge(computeAveragesId, computeTrendsId, { line: 30 }));
  edges.push(createCallEdge(getMetricsId, paginateResultsId, { line: 45 }));
  edges.push(createCallEdge(paginateResultsId, formatReportId, { line: 20 }));
  edges.push(createCallEdge(formatReportId, cacheResultsId, { line: 30, isAsync: true }));
  edges.push(createCallEdge(aggregateMetricsId, findMetricsByRangeId, { line: 30, isAsync: true }));

  // ==== ENTITY OPERATIONS ====
  // Metric entity
  edges.push(createOperatesOnEdge(getMetricsId, metricEntity.id, 'read'));
  edges.push(createOperatesOnEdge(findMetricsByRangeId, metricEntity.id, 'read'));
  edges.push(
    createOperatesOnEdge(
      `${h}:function:src/repositories/analytics.repository.ts:aggregateByPeriod`,
      metricEntity.id,
      'read',
    ),
  );

  // Report entity
  edges.push(
    createOperatesOnEdge(
      `${h}:function:src/controllers/analytics.controller.ts:scheduleReport`,
      reportEntity.id,
      'create',
    ),
  );
  edges.push(
    createOperatesOnEdge(
      `${h}:function:src/repositories/analytics.repository.ts:saveReport`,
      reportEntity.id,
      'create',
    ),
  );
  edges.push(
    createOperatesOnEdge(`${h}:function:src/controllers/analytics.controller.ts:getReport`, reportEntity.id, 'read'),
  );
  edges.push(
    createOperatesOnEdge(
      `${h}:function:src/repositories/analytics.repository.ts:findReportById`,
      reportEntity.id,
      'read',
    ),
  );

  // DashboardConfig entity
  edges.push(
    createOperatesOnEdge(
      `${h}:function:src/controllers/analytics.controller.ts:getDashboard`,
      dashboardConfigEntity.id,
      'read',
    ),
  );
  edges.push(
    createOperatesOnEdge(
      `${h}:function:src/repositories/analytics.repository.ts:findDashboardConfig`,
      dashboardConfigEntity.id,
      'read',
    ),
  );
  edges.push(
    createOperatesOnEdge(
      `${h}:function:src/repositories/analytics.repository.ts:saveDashboardConfig`,
      dashboardConfigEntity.id,
      'update',
    ),
  );

  return { nodes, edges };
}

// =============================================================================
// Main Export: Create All Realistic Seed Data
// =============================================================================

export interface SeedDataResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    repos: number;
    functions: number;
    classes: number;
    entities: number;
    entrypoints: number;
    edges: number;
  };
}

export function createRealisticSeedData(): SeedDataResult {
  // Reset edge counter for deterministic IDs
  edgeCounter = 0;

  const userData = createUserServiceData();
  const orderData = createOrderServiceData();
  const analyticsData = createAnalyticsServiceData();

  const allNodes = [...userData.nodes, ...orderData.nodes, ...analyticsData.nodes];
  const allEdges = [...userData.edges, ...orderData.edges, ...analyticsData.edges];

  const stats = {
    repos: allNodes.filter((n) => n.type === 'repository').length,
    functions: allNodes.filter((n) => n.type === 'function').length,
    classes: allNodes.filter((n) => n.type === 'class').length,
    entities: allNodes.filter((n) => n.type === 'entity').length,
    entrypoints: allNodes.filter((n) => n.type === 'entrypoint').length,
    edges: allEdges.length,
  };

  return { nodes: allNodes, edges: allEdges, stats };
}

// =============================================================================
// Legacy seed data for backward compatibility with existing tests
// =============================================================================

export const LEGACY_REPO_HASH = 'abc123def456';

export function createLegacySeedData(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const REPO_HASH = LEGACY_REPO_HASH;

  const nodes: GraphNode[] = [
    // Repository
    {
      id: REPO_HASH,
      type: NodeType.Repository,
      name: 'test-service',
      properties: { type: 'backend', parsedAt: '2024-01-15T10:00:00.000Z' },
    },

    // Files
    {
      id: `${REPO_HASH}:file:src/users/service.ts`,
      type: NodeType.File,
      name: 'src/users/service.ts',
      properties: { path: 'src/users/service.ts', extension: '.ts' },
      repoId: REPO_HASH,
      filePath: 'src/users/service.ts',
    },
    {
      id: `${REPO_HASH}:file:src/users/controller.ts`,
      type: NodeType.File,
      name: 'src/users/controller.ts',
      properties: { path: 'src/users/controller.ts', extension: '.ts' },
      repoId: REPO_HASH,
      filePath: 'src/users/controller.ts',
    },
    {
      id: `${REPO_HASH}:file:src/users/validator.ts`,
      type: NodeType.File,
      name: 'src/users/validator.ts',
      properties: { path: 'src/users/validator.ts', extension: '.ts' },
      repoId: REPO_HASH,
      filePath: 'src/users/validator.ts',
    },

    // Classes
    {
      id: `${REPO_HASH}:class:src/users/service.ts:UserService`,
      type: NodeType.Class,
      name: 'UserService',
      properties: { isExported: true },
      repoId: REPO_HASH,
      filePath: 'src/users/service.ts',
      startLine: 10,
      endLine: 100,
    },
    {
      id: `${REPO_HASH}:class:src/users/controller.ts:UserController`,
      type: NodeType.Class,
      name: 'UserController',
      properties: { isExported: true },
      repoId: REPO_HASH,
      filePath: 'src/users/controller.ts',
      startLine: 5,
      endLine: 80,
    },

    // Functions
    {
      id: `${REPO_HASH}:function:src/users/service.ts:createUser`,
      type: NodeType.Function,
      name: 'createUser',
      summary: 'Creates a new user in the database',
      properties: {
        kind: 'method',
        isAsync: true,
        classId: `${REPO_HASH}:class:src/users/service.ts:UserService`,
        visibility: 'public',
      },
      repoId: REPO_HASH,
      filePath: 'src/users/service.ts',
      startLine: 20,
      endLine: 40,
    },
    {
      id: `${REPO_HASH}:function:src/users/service.ts:getUser`,
      type: NodeType.Function,
      name: 'getUser',
      summary: 'Retrieves a user by ID',
      properties: {
        kind: 'method',
        isAsync: true,
        classId: `${REPO_HASH}:class:src/users/service.ts:UserService`,
      },
      repoId: REPO_HASH,
      filePath: 'src/users/service.ts',
      startLine: 45,
      endLine: 60,
    },
    {
      id: `${REPO_HASH}:function:src/users/validator.ts:validateUser`,
      type: NodeType.Function,
      name: 'validateUser',
      summary: 'Validates user input data',
      properties: { kind: 'function', isAsync: false },
      repoId: REPO_HASH,
      filePath: 'src/users/validator.ts',
      startLine: 5,
      endLine: 25,
    },
    {
      id: `${REPO_HASH}:function:src/users/controller.ts:handleCreateUser`,
      type: NodeType.Function,
      name: 'handleCreateUser',
      summary: 'HTTP handler for user creation',
      properties: {
        kind: 'method',
        isAsync: true,
        classId: `${REPO_HASH}:class:src/users/controller.ts:UserController`,
      },
      repoId: REPO_HASH,
      filePath: 'src/users/controller.ts',
      startLine: 15,
      endLine: 35,
    },

    // Entity
    {
      id: `${REPO_HASH}:entity:src/entities/user.ts:User`,
      type: NodeType.Entity,
      name: 'User',
      properties: { tableName: 'users', ormType: 'TypeORM' },
      repoId: REPO_HASH,
      filePath: 'src/entities/user.ts',
      startLine: 5,
      endLine: 30,
    },

    // Entrypoints
    {
      id: `${REPO_HASH}:entrypoint:src/users/controller.ts:POST:/api/users`,
      type: NodeType.Entrypoint,
      name: 'POST /api/users',
      properties: {
        entrypointType: 'http',
        method: 'POST',
        path: '/users',
        fullPath: '/api/users',
        handlerId: `${REPO_HASH}:function:src/users/controller.ts:handleCreateUser`,
      },
      repoId: REPO_HASH,
      filePath: 'src/users/controller.ts',
      startLine: 10,
    },
    {
      id: `${REPO_HASH}:entrypoint:src/users/controller.ts:GET:/api/users/:id`,
      type: NodeType.Entrypoint,
      name: 'GET /api/users/:id',
      properties: {
        entrypointType: 'http',
        method: 'GET',
        path: '/users/:id',
        fullPath: '/api/users/:id',
        handlerId: `${REPO_HASH}:function:src/users/controller.ts:handleGetUser`,
      },
      repoId: REPO_HASH,
      filePath: 'src/users/controller.ts',
      startLine: 40,
    },
  ];

  const edges: GraphEdge[] = [
    // Class method relationships
    {
      id: `${REPO_HASH}:edge:has_method:1`,
      sourceId: `${REPO_HASH}:class:src/users/service.ts:UserService`,
      targetId: `${REPO_HASH}:function:src/users/service.ts:createUser`,
      type: EdgeType.HasMethod,
      confidence: 1.0,
      createdBy: 'parser',
      properties: {},
    },
    {
      id: `${REPO_HASH}:edge:has_method:2`,
      sourceId: `${REPO_HASH}:class:src/users/service.ts:UserService`,
      targetId: `${REPO_HASH}:function:src/users/service.ts:getUser`,
      type: EdgeType.HasMethod,
      confidence: 1.0,
      createdBy: 'parser',
      properties: {},
    },
    {
      id: `${REPO_HASH}:edge:has_method:3`,
      sourceId: `${REPO_HASH}:class:src/users/controller.ts:UserController`,
      targetId: `${REPO_HASH}:function:src/users/controller.ts:handleCreateUser`,
      type: EdgeType.HasMethod,
      confidence: 1.0,
      createdBy: 'parser',
      properties: {},
    },

    // Call relationships
    // handleCreateUser -> createUser
    {
      id: `${REPO_HASH}:edge:calls:1`,
      sourceId: `${REPO_HASH}:function:src/users/controller.ts:handleCreateUser`,
      targetId: `${REPO_HASH}:function:src/users/service.ts:createUser`,
      type: EdgeType.Calls,
      confidence: 1.0,
      createdBy: 'parser',
      properties: { line: 20, isAsync: true },
    },
    // createUser -> validateUser
    {
      id: `${REPO_HASH}:edge:calls:2`,
      sourceId: `${REPO_HASH}:function:src/users/service.ts:createUser`,
      targetId: `${REPO_HASH}:function:src/users/validator.ts:validateUser`,
      type: EdgeType.Calls,
      confidence: 1.0,
      createdBy: 'parser',
      properties: { line: 25, isAsync: false },
    },

    // Entrypoint handlers
    {
      id: `${REPO_HASH}:edge:handles:1`,
      sourceId: `${REPO_HASH}:entrypoint:src/users/controller.ts:POST:/api/users`,
      targetId: `${REPO_HASH}:function:src/users/controller.ts:handleCreateUser`,
      type: EdgeType.Handles,
      confidence: 1.0,
      createdBy: 'parser',
      properties: {},
    },

    // Entity operations
    // createUser operates on User entity
    {
      id: `${REPO_HASH}:edge:operates:1`,
      sourceId: `${REPO_HASH}:function:src/users/service.ts:createUser`,
      targetId: `${REPO_HASH}:entity:src/entities/user.ts:User`,
      type: EdgeType.OperatesOn,
      confidence: 1.0,
      createdBy: 'parser',
      properties: { operation: 'create' },
    },
    // getUser operates on User entity
    {
      id: `${REPO_HASH}:edge:operates:2`,
      sourceId: `${REPO_HASH}:function:src/users/service.ts:getUser`,
      targetId: `${REPO_HASH}:entity:src/entities/user.ts:User`,
      type: EdgeType.OperatesOn,
      confidence: 1.0,
      createdBy: 'parser',
      properties: { operation: 'read' },
    },
  ];

  return { nodes, edges };
}
