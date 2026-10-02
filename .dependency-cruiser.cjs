/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'domain-should-not-depend-on-application-presentation-infrastructure',
      comment: 'Domain layer must be pure and should not import from outer layers.',
      severity: 'error',
      from: { path: '^apps/api/src/modules/[^/]+/domain/' },
      to: {
        path: [
          '^apps/api/src/modules/[^/]+/application/',
          '^apps/api/src/modules/[^/]+/infrastructure/',
          '^apps/api/src/modules/[^/]+/presentation/',
          'express',
          'drizzle-orm',
          'pg'
        ]
      }
    },
    {
      name: 'application-should-not-depend-on-presentation-infrastructure-or-drizzle',
      comment: 'Application logic must remain independent of delivery, data access details, or query builder implementations.',
      severity: 'error',
      from: { path: '^apps/api/src/modules/[^/]+/application/' },
      to: {
        path: [
          '^apps/api/src/modules/[^/]+/infrastructure/',
          '^apps/api/src/modules/[^/]+/presentation/',
          'express',
          'drizzle-orm',
          'pg'
        ]
      }
    },
    {
      name: 'controller-should-not-depend-on-repository-or-drizzle',
      comment: 'Controllers and presentation layers must not import concrete database repositories or query builder details.',
      severity: 'error',
      from: { path: '^apps/api/src/modules/[^/]+/presentation/' },
      to: {
        path: [
          '^apps/api/src/modules/[^/]+/infrastructure/database/',
          'drizzle-orm',
          'pg'
        ]
      }
    },
    {
      name: 'no-cross-module-internal-imports',
      comment: 'Modules must not import from internal directories of other modules. Access must be via defined APIs.',
      severity: 'error',
      from: { path: '^apps/api/src/modules/([^/]+)/' },
      to: {
        path: '^apps/api/src/modules/(?!$1)[^/]+/',
        pathNot: [
          '^apps/api/src/modules/[^/]+/presentation/http/.*\\.api\\.ts$',
          '^apps/api/src/modules/[^/]+/contracts/'
        ]
      }
    },
    {
      name: 'no-production-import-of-integration-tests',
      comment: 'modules/<m>/__integration__/ holds cross-layer integration tests only; no other code may import from it.',
      severity: 'error',
      from: { path: '^apps/api/src/', pathNot: '/__integration__/' },
      to: { path: '/__integration__/' }
    },
    {
      name: 'integration-dir-holds-tests-only',
      comment: 'Only *.test.ts files may live in __integration__/ (exempt from the layer rules because it is test-only).',
      severity: 'error',
      from: { path: '/__integration__/', pathNot: '[.]test[.]ts$' },
      to: {}
    },
    {
      name: 'core-should-not-depend-on-business-modules',
      comment: 'Core layer must remain independent of specific business modules.',
      severity: 'error',
      from: { path: '^apps/api/src/core/' },
      to: { path: '^apps/api/src/modules/' }
    }
  ],
  options: {
    doNotFollow: {
      path: 'node_modules'
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: 'tsconfig.json'
    },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"]
    }
  }
};
