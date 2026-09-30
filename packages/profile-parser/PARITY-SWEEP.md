# Parity Sweep — substrate (tree-sitter+SCIP) vs ts-morph (oracle)

Generated: 2026-06-17T15:28:29.271Z
Decommission gate: can the ts-morph engine be deleted without losing category coverage or call-tree fidelity?


## Overall matrix

| repo | category fails | call-tree recall | sub name-match | call-tree | validate (ts/sub) | verdict |
|---|---|--:|--:|:--|:--|:--|
| acme-core | — | 96.8% | 100.0% | PASS | ok/ok | PASS |
| acme-schedules | — | 98.5% | 100.0% | PASS | ok/ok | PASS |
| acme-shifts | — | 96.4% | 99.8% | PASS | ok/ok | PASS |
| financial-data-analyst | — | 100.0% | 100.0% | PASS | ok/ok | PASS |
| acme-admin | — | 97.8% | 100.0% | PASS | ok/ok | PASS |

## Overall decommission-gate verdict: **PASS — ts-morph engine can be deleted**

---


## acme-core
repo: `/path/to/acme/acme-core`

### 1. Category counts (substrate vs ts-morph)

| category | substrate | ts-morph | verdict |
|---|--:|--:|:--|
| functions | 812 | 628 | PASS |
| classes | 487 | 487 | PASS |
| interfaces | 57 | 57 | PASS |
| typeAliases | 10 | 10 | PASS |
| enums | 53 | 53 | PASS |
| variables | 58 | 58 | PASS |
| entrypoints:http | 132 | 132 | PASS |
| entrypoints:queue | 3 | 3 | PASS |
| entrypoints:event | 0 | 0 | PASS |
| entrypoints:cli | 0 | 0 | PASS |
| entities | 104 | 104 | PASS |
| dbOperations | 232 | 232 | PASS |
| externalCalls | 39 | 39 | PASS |
| components | 0 | 0 | PASS |
| routes | 0 | 0 | PASS |
| routes(componentId-resolved) | 0 | 0 | PASS |
| stateStores | 0 | 0 | PASS |

validate-output: ts-morph valid=true errors=0 | substrate valid=true errors=0

### 1b. Category counts (substrate vs CURATED — production reference, not a gate)

| category | substrate | curated | delta (sub−cur) |
|---|--:|--:|--:|
| functions | 812 | 619 | +193 |
| classes | 487 | 479 | +8 |
| interfaces | 57 | 57 | 0 |
| typeAliases | 10 | 10 | 0 |
| enums | 53 | 53 | 0 |
| variables | 58 | 58 | 0 |
| entrypoints:http | 132 | 131 | +1 |
| entrypoints:queue | 3 | 0 | +3 |
| entrypoints:event | 0 | 0 | 0 |
| entrypoints:cli | 0 | 0 | 0 |
| entities | 104 | 104 | 0 |
| dbOperations | 232 | 344 | -112 |
| externalCalls | 39 | 32 | +7 |
| components | 0 | 0 | 0 |
| routes | 0 | 0 | 0 |
| routes(componentId-resolved) | 0 | 0 | 0 |
| stateStores | 0 | 0 | 0 |

_Curated is a reference bar, not gospel — deltas surface the real production gap (dbOps, calls, externalCalls including internal-SDK egress); they do not gate decommission._

### 2. Call-tree (caller→callee) deep dive

resolved internal edges: substrate 791 | ts-morph 577
method→method edges:     substrate 791 | ts-morph 577

**resolved-edge name-match (callee node name == call expr): substrate 791/791 = 100.0% | ts-morph 577/577 = 100.0%**
(ts-morph resolves to the exact named callee; substrate resolves many `local N` / mismatched SCIP symbols onto real nodes — those resolved edges are spurious.)

**call-tree recall (resolved): 542/560 = 96.8%** (nesting-aware; exact-caller-id = 96.4%)
method→method recall: 542/560 = 96.8% (nesting-aware)

substrate-only resolved edges (extras): 185
  of which name-match (plausibly genuine): 185 | name-MISMATCH (noise): 0 (0.0%)
sample (classified):
  - `method:src/modules/user-profiles/user-profiles.service.ts:UserProfilesService.getUserProfiles->method:src/lib/logger/contexted-logger.ts:ContextedLogger.log` @src/modules/user-profiles/user-profiles.service.ts:68 — real method call (name matches)
  - `method:src/modules/user-profiles/user-profiles.service.ts:UserProfilesService.setLocationsForProfiles->method:src/lib/logger/contexted-logger.ts:ContextedLogger.warn` @src/modules/user-profiles/user-profiles.service.ts:123 — real method call (name matches)
  - `method:src/modules/user-profiles/user-profiles.service.ts:UserProfilesService.setBookingSettingsForProfiles->method:src/lib/logger/contexted-logger.ts:ContextedLogger.warn` @src/modules/user-profiles/user-profiles.service.ts:166 — real method call (name matches)
  - `method:src/modules/user-profiles/user-profiles.service.ts:UserProfilesService.authSync->method:src/lib/logger/contexted-logger.ts:ContextedLogger.log` @src/modules/user-profiles/user-profiles.service.ts:414 — real method call (name matches)
  - `method:src/modules/user-profiles/user-profiles.service.ts:UserProfilesService.authSync->method:src/lib/logger/contexted-logger.ts:ContextedLogger.debug` @src/modules/user-profiles/user-profiles.service.ts:426 — real method call (name matches)
  - `method:src/modules/user-profiles/user-profiles.service.ts:UserProfilesService.authSyncMobile->method:src/lib/logger/contexted-logger.ts:ContextedLogger.log` @src/modules/user-profiles/user-profiles.service.ts:482 — real method call (name matches)
  - `method:src/modules/user-profiles/user-profiles.service.ts:UserProfilesService.getUserProfilesByPermissions->method:src/lib/logger/contexted-logger.ts:ContextedLogger.debug` @src/modules/user-profiles/user-profiles.service.ts:879 — real method call (name matches)
  - `method:src/modules/user-profiles/user-profiles.service.ts:UserProfilesService.resetFacialRecognition->method:src/lib/logger/contexted-logger.ts:ContextedLogger.log` @src/modules/user-profiles/user-profiles.service.ts:1007 — real method call (name matches)
  - `method:src/modules/user-profile-obligations/repositories/user-profile-obligations.repository.ts:UserProfileObligationsRepository.softDelete->method:src/modules/user-profile-obligations/repositories/base.repository.ts:BaseRepository.findByUuid` @src/modules/user-profile-obligations/repositories/user-profile-obligations.repository.ts:15 — real method call (name matches)
  - `method:src/modules/user-profile-obligations/repositories/user-profile-obligations.repository.ts:UserProfileObligationsRepository.softDelete->method:src/modules/user-profile-obligations/repositories/base.repository.ts:BaseRepository.saveEntity` @src/modules/user-profile-obligations/repositories/user-profile-obligations.repository.ts:24 — real method call (name matches)

ts-morph-only resolved edges the substrate MISSES (nesting-aware, genuine): 18
sample:
  - `method:src/config/mikro-orm.ts:EntityCustomNamingStrategy.joinColumnName->method:src/config/mikro-orm.ts:EntityCustomNamingStrategy.underscore` @src/config/mikro-orm.ts:12 (expr: this.underscore, method=true)
  - `method:src/lib/logger/contexted-logger.ts:ContextedLogger.buildError->method:src/lib/logger/contexted-logger.ts:ContextedLogger.build` @src/lib/logger/contexted-logger.ts:36 (expr: this.build, method=true)
  - `method:src/modules/companies/companies.controller.ts:CompaniesController.getCompanyConfig->method:src/modules/companies/companies.service.ts:CompaniesService.getMergedPartnerAndCompanyConfig` @src/modules/companies/companies.controller.ts:196 (expr: this.companiesService.getMergedPartnerAndCompanyConfig, method=true)
  - `method:src/modules/companies/companies.service.ts:CompaniesService.getMergedPartnerAndCompanyConfig->method:src/modules/companies/companies.service.ts:CompaniesService.mergePartnerAndCompanyConfig` @src/modules/companies/companies.service.ts:1505 (expr: this.mergePartnerAndCompanyConfig, method=true)
  - `method:src/modules/companies/companies.service.ts:CompaniesService.getMergedPartnerAndCompanyConfigByDomain->method:src/modules/companies/companies.service.ts:CompaniesService.mergePartnerAndCompanyConfig` @src/modules/companies/companies.service.ts:1623 (expr: this.mergePartnerAndCompanyConfig, method=true)
  - `method:src/modules/user/user.service.ts:UserService.getUserById->method:src/modules/user/user.service.ts:UserService.getCacheKey` @src/modules/user/user.service.ts:26 (expr: this.getCacheKey, method=true)
  - `method:src/modules/user/user.service.ts:UserService.userProfilesResponseFromUser->method:src/modules/user/user.service.ts:UserService.getCacheKey` @src/modules/user/user.service.ts:202 (expr: this.getCacheKey, method=true)
  - `method:src/modules/user-profiles/user-profiles.service.ts:UserProfilesService.externalProfileLoginToken->method:src/modules/companies/companies.service.ts:CompaniesService.getMergedPartnerAndCompanyConfig` @src/modules/user-profiles/user-profiles.service.ts:272 (expr: this.companiesService.getMergedPartnerAndCompanyConfig, method=true)

call-tree verdict: PASS (gate: recall ≥ 90.0% on both edges & method→method, AND substrate resolved-edge name-match ≥ 90.0%)

### Verdict: acme-core → PASS

## acme-schedules
repo: `/path/to/acme/acme-schedules`

### 1. Category counts (substrate vs ts-morph)

| category | substrate | ts-morph | verdict |
|---|--:|--:|:--|
| functions | 710 | 591 | PASS |
| classes | 96 | 96 | PASS |
| interfaces | 0 | 0 | PASS |
| typeAliases | 0 | 0 | PASS |
| enums | 0 | 0 | PASS |
| variables | 421 | 421 | PASS |
| entrypoints:http | 82 | 82 | PASS |
| entrypoints:queue | 9 | 9 | PASS |
| entrypoints:event | 0 | 0 | PASS |
| entrypoints:cli | 0 | 0 | PASS |
| entities | 16 | 16 | PASS |
| dbOperations | 135 | 135 | PASS |
| externalCalls | 6 | 6 | PASS |
| components | 0 | 0 | PASS |
| routes | 0 | 0 | PASS |
| routes(componentId-resolved) | 0 | 0 | PASS |
| stateStores | 0 | 0 | PASS |

validate-output: ts-morph valid=true errors=0 | substrate valid=true errors=0

### 1b. Category counts (substrate vs CURATED — production reference, not a gate)

| category | substrate | curated | delta (sub−cur) |
|---|--:|--:|--:|
| functions | 710 | 592 | +118 |
| classes | 96 | 96 | 0 |
| interfaces | 0 | 0 | 0 |
| typeAliases | 0 | 0 | 0 |
| enums | 0 | 0 | 0 |
| variables | 421 | 487 | -66 |
| entrypoints:http | 82 | 83 | -1 |
| entrypoints:queue | 9 | 9 | 0 |
| entrypoints:event | 0 | 7 | -7 |
| entrypoints:cli | 0 | 0 | 0 |
| entities | 16 | 16 | 0 |
| dbOperations | 135 | 8 | +127 |
| externalCalls | 6 | 52 | -46 |
| components | 0 | 0 | 0 |
| routes | 0 | 0 | 0 |
| routes(componentId-resolved) | 0 | 0 | 0 |
| stateStores | 0 | 0 | 0 |

_Curated is a reference bar, not gospel — deltas surface the real production gap (dbOps, calls, externalCalls including internal-SDK egress); they do not gate decommission._

### 2. Call-tree (caller→callee) deep dive

resolved internal edges: substrate 438 | ts-morph 281
method→method edges:     substrate 438 | ts-morph 281

**resolved-edge name-match (callee node name == call expr): substrate 438/438 = 100.0% | ts-morph 281/281 = 100.0%**
(ts-morph resolves to the exact named callee; substrate resolves many `local N` / mismatched SCIP symbols onto real nodes — those resolved edges are spurious.)

**call-tree recall (resolved): 257/261 = 98.5%** (nesting-aware; exact-caller-id = 98.5%)
method→method recall: 257/261 = 98.5% (nesting-aware)

substrate-only resolved edges (extras): 134
  of which name-match (plausibly genuine): 134 | name-MISMATCH (noise): 0 (0.0%)
sample (classified):
  - `method:app/services/automatic-bookings-service.js:AutomaticBookingsService.scheduleAutomaticBookingsFiltered->method:app/services/automatic-bookings/triggers-generator.js:AutomaticBookingsTriggersGenerator.generatePendingTriggersForAllShifts` @app/services/automatic-bookings-service.js:53 — real method call (name matches)
  - `method:app/services/shifts-generation-service.js:ShiftsGenerationService.ensureShiftsForTheUserProfileSchedule->method:app/services/shifts-generator/base-shifts-generator.js:BaseShiftsGenerator.run` @app/services/shifts-generation-service.js:239 — real method call (name matches)
  - `method:app/services/shifts-import-service.js:ShiftsImportService.processImportFile->method:app/services/shifts-file-importer/index.js:ShiftsFileImporter.init` @app/services/shifts-import-service.js:22 — real method call (name matches)
  - `method:app/services/shifts-import-service.js:ShiftsImportService.processImportFile->method:app/services/shifts-file-importer/index.js:ShiftsFileImporter.execute` @app/services/shifts-import-service.js:23 — real method call (name matches)
  - `method:app/services/shifts-generator/base-shifts-generator.js:BaseShiftsGenerator.constructor->method:app/services/shifts-generator/base-shifts-generator.js:BaseShiftsGenerator.mergeEventsToScheduleExceptionDays` @app/services/shifts-generator/base-shifts-generator.js:44 — real method call (name matches)
  - `method:app/services/shifts-generator/daily-shifts-generator.js:DailyShiftsGenerator.generateShiftFor->method:app/services/shifts-generator/base-shifts-generator.js:BaseShiftsGenerator.getDayById` @app/services/shifts-generator/daily-shifts-generator.js:30 — real method call (name matches)
  - `method:app/services/shifts-generator/weekly-shifts-generator.js:WeeklyShiftsGenerator.generateShiftFor->method:app/services/shifts-generator/base-shifts-generator.js:BaseShiftsGenerator.getDayById` @app/services/shifts-generator/weekly-shifts-generator.js:23 — real method call (name matches)
  - `method:app/services/shifts-file-importer/stages/apply-execution-plan-stage.js:ApplyExecutionPlan.executeStageLogic->method:app/services/shifts-file-importer/stages/base-stage.js:BaseStage.getImportData` @app/services/shifts-file-importer/stages/apply-execution-plan-stage.js:26 — real method call (name matches)
  - `method:app/services/shifts-file-importer/stages/apply-execution-plan-stage.js:ApplyExecutionPlan.updateEntityStateInStageProcessingState->method:app/services/shifts-file-importer/stages/base-stage.js:BaseStage.fetchStageProcessingState` @app/services/shifts-file-importer/stages/apply-execution-plan-stage.js:175 — real method call (name matches)
  - `method:app/services/shifts-file-importer/stages/apply-execution-plan-stage.js:ApplyExecutionPlan.updateEntityStateInStageProcessingState->method:app/services/shifts-file-importer/stages/base-stage.js:BaseStage.updateStageProcessingState` @app/services/shifts-file-importer/stages/apply-execution-plan-stage.js:180 — real method call (name matches)

ts-morph-only resolved edges the substrate MISSES (nesting-aware, genuine): 4
sample:
  - `method:app/repositories/schedules-repository.js:SchedulesRepository.generateScheduleVersion->method:app/repositories/schedules-repository.js:SchedulesRepository.getCurrentScheduleVersion` @app/repositories/schedules-repository.js:66 (expr: this.getCurrentScheduleVersion, method=true)
  - `method:app/repositories/schedules-repository.js:SchedulesRepository.listSchedulesForCompanyUserProfiles->method:app/repositories/schedules-repository.js:SchedulesRepository.listUserProfileSchedules` @app/repositories/schedules-repository.js:531 (expr: this.listUserProfileSchedules, method=true)
  - `method:app/services/schedule-exceptions-management-service.js:ScheduleExceptionsManagementService.createExceptionRequest->method:app/services/schedule-exceptions-management-service.js:ScheduleExceptionsManagementService.create` @app/services/schedule-exceptions-management-service.js:122 (expr: this.create, method=true)
  - `method:app/services/schedule-exceptions-management-service.js:ScheduleExceptionsManagementService.enableDay->method:app/services/schedule-exceptions-management-service.js:ScheduleExceptionsManagementService.create` @app/services/schedule-exceptions-management-service.js:205 (expr: this.create, method=true)

call-tree verdict: PASS (gate: recall ≥ 90.0% on both edges & method→method, AND substrate resolved-edge name-match ≥ 90.0%)

### Verdict: acme-schedules → PASS

## acme-shifts
repo: `/path/to/acme/acme-shifts`

### 1. Category counts (substrate vs ts-morph)

| category | substrate | ts-morph | verdict |
|---|--:|--:|:--|
| functions | 680 | 563 | PASS |
| classes | 180 | 180 | PASS |
| interfaces | 41 | 41 | PASS |
| typeAliases | 3 | 3 | PASS |
| enums | 9 | 9 | PASS |
| variables | 45 | 45 | PASS |
| entrypoints:http | 81 | 81 | PASS |
| entrypoints:queue | 6 | 6 | PASS |
| entrypoints:event | 0 | 0 | PASS |
| entrypoints:cli | 0 | 0 | PASS |
| entities | 14 | 14 | PASS |
| dbOperations | 133 | 133 | PASS |
| externalCalls | 8 | 8 | PASS |
| components | 0 | 0 | PASS |
| routes | 0 | 0 | PASS |
| routes(componentId-resolved) | 0 | 0 | PASS |
| stateStores | 0 | 0 | PASS |

validate-output: ts-morph valid=true errors=0 | substrate valid=true errors=0

### 1b. Category counts (substrate vs CURATED — production reference, not a gate)

| category | substrate | curated | delta (sub−cur) |
|---|--:|--:|--:|
| functions | 680 | 450 | +230 |
| classes | 180 | 129 | +51 |
| interfaces | 41 | 38 | +3 |
| typeAliases | 3 | 3 | 0 |
| enums | 9 | 9 | 0 |
| variables | 45 | 42 | +3 |
| entrypoints:http | 81 | 77 | +4 |
| entrypoints:queue | 6 | 3 | +3 |
| entrypoints:event | 0 | 0 | 0 |
| entrypoints:cli | 0 | 0 | 0 |
| entities | 14 | 14 | 0 |
| dbOperations | 133 | 228 | -95 |
| externalCalls | 8 | 52 | -44 |
| components | 0 | 0 | 0 |
| routes | 0 | 0 | 0 |
| routes(componentId-resolved) | 0 | 0 | 0 |
| stateStores | 0 | 0 | 0 |

_Curated is a reference bar, not gospel — deltas surface the real production gap (dbOps, calls, externalCalls including internal-SDK egress); they do not gate decommission._

### 2. Call-tree (caller→callee) deep dive

resolved internal edges: substrate 646 | ts-morph 609
method→method edges:     substrate 646 | ts-morph 609

**resolved-edge name-match (callee node name == call expr): substrate 645/646 = 99.8% | ts-morph 609/609 = 100.0%**
(ts-morph resolves to the exact named callee; substrate resolves many `local N` / mismatched SCIP symbols onto real nodes — those resolved edges are spurious.)

**call-tree recall (resolved): 533/553 = 96.4%** (nesting-aware; exact-caller-id = 95.7%)
method→method recall: 533/553 = 96.4% (nesting-aware)

substrate-only resolved edges (extras): 38
  of which name-match (plausibly genuine): 37 | name-MISMATCH (noise): 1 (2.6%)
sample (classified):
  - `method:src/modules/user-profile-planning-spaces/user-profile-planning-spaces.repository.ts:UserProfilePlanningSpacesRepository.createUserProfilePlanningSpace->method:src/shared/repositories/base.repository.ts:BaseRepository.saveMany` @src/modules/user-profile-planning-spaces/user-profile-planning-spaces.repository.ts:62 — real method call (name matches)
  - `method:src/modules/user-profile-planning-spaces/user-profile-planning-spaces.repository.ts:UserProfilePlanningSpacesRepository.updateUserProfilePlanningSpace->method:src/shared/repositories/base.repository.ts:BaseRepository.saveEntity` @src/modules/user-profile-planning-spaces/user-profile-planning-spaces.repository.ts:109 — real method call (name matches)
  - `method:src/modules/user-profile-planning-spaces/user-profile-planning-spaces.repository.ts:UserProfilePlanningSpacesRepository.softDelete->method:src/shared/repositories/base.repository.ts:BaseRepository.saveEntity` @src/modules/user-profile-planning-spaces/user-profile-planning-spaces.repository.ts:136 — real method call (name matches)
  - `method:src/modules/templates/templates.repository.ts:TemplatesRepository.upsertTemplate->method:src/shared/repositories/base.repository.ts:BaseRepository.saveEntity` @src/modules/templates/templates.repository.ts:42 — real method call (name matches)
  - `method:src/modules/ta-sync/ta-sync.service.ts:TaSyncService.syncSingleCompany->method:src/lib/logger/contexted-logger.ts:ContextedLogger.log` @src/modules/ta-sync/ta-sync.service.ts:165 — real method call (name matches)
  - `method:src/modules/rest-days/rest-days.service.ts:RestDaysService.create->method:src/modules/rest-days/handlers/rest-day.handler.ts:RestDayHandler.validate` @src/modules/rest-days/rest-days.service.ts:70 — real method call (name matches)
  - `method:src/modules/rest-days/rest-days.service.ts:RestDaysService.update->method:src/modules/rest-days/handlers/rest-day.handler.ts:RestDayHandler.validate` @src/modules/rest-days/rest-days.service.ts:268 — real method call (name matches)
  - `function:src/modules/print/pdf-template.service.ts:t->method:src/modules/print/lokalise.service.ts:LokaliseService.translate` @src/modules/print/pdf-template.service.ts:135 — real method call (name matches)
  - `method:src/modules/planning-spaces/planning-space-settings.repository.ts:PlanningSpacesSettingsRepository.updatePlanningSpaceSettings->method:src/shared/repositories/base.repository.ts:BaseRepository.saveEntity` @src/modules/planning-spaces/planning-space-settings.repository.ts:43 — real method call (name matches)
  - `method:src/modules/planning-spaces/planning-space-settings.repository.ts:PlanningSpacesSettingsRepository.updatePlanningSpaceAlerts->method:src/shared/repositories/base.repository.ts:BaseRepository.saveEntity` @src/modules/planning-spaces/planning-space-settings.repository.ts:69 — real method call (name matches)

ts-morph-only resolved edges the substrate MISSES (nesting-aware, genuine): 20
sample:
  - `method:src/config/mikro-orm.ts:EntityCustomNamingStrategy.joinColumnName->method:src/config/mikro-orm.ts:EntityCustomNamingStrategy.underscore` @src/config/mikro-orm.ts:10 (expr: this.underscore, method=true)
  - `method:src/lib/logger/contexted-logger.ts:ContextedLogger.buildError->method:src/lib/logger/contexted-logger.ts:ContextedLogger.build` @src/lib/logger/contexted-logger.ts:36 (expr: this.build, method=true)
  - `method:src/modules/patterns/patterns.controller.ts:PatternsController.apply->function:src/modules/user-profile-planning-spaces/planning-space-member.decorator.ts:RequirePlanningSpaceAccess` @src/modules/patterns/patterns.controller.ts:145 (expr: RequirePlanningSpaceAccess, method=false)
  - `method:src/modules/print/pdf-template.service.ts:PdfTemplateService.createTeamSchedulePdfStream->method:src/modules/print/pdf-template.service.ts:PdfTemplateService.minutesToHours` @src/modules/print/pdf-template.service.ts:403 (expr: this.minutesToHours, method=true)
  - `method:src/modules/rest-days/rest-days.controller.ts:RestDaysController.calendarViewList->function:src/modules/user-profile-planning-spaces/planning-space-member.decorator.ts:RequirePlanningSpaceAccess` @src/modules/rest-days/rest-days.controller.ts:192 (expr: RequirePlanningSpaceAccess, method=false)
  - `method:src/modules/rest-days/rest-days.controller.ts:RestDaysController.combinedCalendarViewList->function:src/modules/user-profile-planning-spaces/planning-space-member.decorator.ts:RequirePlanningSpaceAccess` @src/modules/rest-days/rest-days.controller.ts:214 (expr: RequirePlanningSpaceAccess, method=false)
  - `method:src/modules/shifts/shifts.controller.ts:ShiftsController.createBulk->function:src/modules/user-profile-planning-spaces/planning-space-member.decorator.ts:RequirePlanningSpaceAccess` @src/modules/shifts/shifts.controller.ts:66 (expr: RequirePlanningSpaceAccess, method=false)
  - `method:src/modules/shifts/shifts.controller.ts:ShiftsController.calendarViewList->function:src/modules/user-profile-planning-spaces/planning-space-member.decorator.ts:RequirePlanningSpaceAccess` @src/modules/shifts/shifts.controller.ts:233 (expr: RequirePlanningSpaceAccess, method=false)

call-tree verdict: PASS (gate: recall ≥ 90.0% on both edges & method→method, AND substrate resolved-edge name-match ≥ 90.0%)

### Verdict: acme-shifts → PASS

## financial-data-analyst
repo: `claude-quickstarts/financial-data-analyst`

### 1. Category counts (substrate vs ts-morph)

| category | substrate | ts-morph | verdict |
|---|--:|--:|:--|
| functions | 44 | 33 | PASS |
| classes | 0 | 0 | PASS |
| interfaces | 15 | 15 | PASS |
| typeAliases | 9 | 9 | PASS |
| enums | 0 | 0 | PASS |
| variables | 56 | 56 | PASS |
| entrypoints:http | 1 | 1 | PASS |
| entrypoints:queue | 0 | 0 | PASS |
| entrypoints:event | 0 | 0 | PASS |
| entrypoints:cli | 0 | 0 | PASS |
| entities | 0 | 0 | PASS |
| dbOperations | 0 | 0 | PASS |
| externalCalls | 2 | 2 | PASS |
| components | 47 | 47 | PASS |
| routes | 0 | 0 | PASS |
| routes(componentId-resolved) | 0 | 0 | PASS |
| stateStores | 0 | 0 | PASS |

validate-output: ts-morph valid=true errors=0 | substrate valid=true errors=0

### 1b. Category counts (substrate vs CURATED — production reference, not a gate)

| category | substrate | curated | delta (sub−cur) |
|---|--:|--:|--:|
| functions | 44 | 32 | +12 |
| classes | 0 | 0 | 0 |
| interfaces | 15 | 15 | 0 |
| typeAliases | 9 | 9 | 0 |
| enums | 0 | 0 | 0 |
| variables | 56 | 56 | 0 |
| entrypoints:http | 1 | 1 | 0 |
| entrypoints:queue | 0 | 0 | 0 |
| entrypoints:event | 0 | 0 | 0 |
| entrypoints:cli | 0 | 0 | 0 |
| entities | 0 | 0 | 0 |
| dbOperations | 0 | 0 | 0 |
| externalCalls | 2 | 2 | 0 |
| components | 47 | 12 | +35 |
| routes | 0 | 0 | 0 |
| routes(componentId-resolved) | 0 | 0 | 0 |
| stateStores | 0 | 0 | 0 |

_Curated is a reference bar, not gospel — deltas surface the real production gap (dbOps, calls, externalCalls including internal-SDK egress); they do not gate decommission._

### 2. Call-tree (caller→callee) deep dive

resolved internal edges: substrate 49 | ts-morph 21
method→method edges:     substrate 49 | ts-morph 21

**resolved-edge name-match (callee node name == call expr): substrate 49/49 = 100.0% | ts-morph 21/21 = 100.0%**
(ts-morph resolves to the exact named callee; substrate resolves many `local N` / mismatched SCIP symbols onto real nodes — those resolved edges are spurious.)

**call-tree recall (resolved): 13/13 = 100.0%** (nesting-aware; exact-caller-id = 61.5%)
method→method recall: 13/13 = 100.0% (nesting-aware)

substrate-only resolved edges (extras): 25
  of which name-match (plausibly genuine): 25 | name-MISMATCH (noise): 0 (0.0%)
sample (classified):
  - `function:hooks/use-toast.ts:update->function:hooks/use-toast.ts:dispatch` @hooks/use-toast.ts:149 — real function call (name matches)
  - `function:hooks/use-toast.ts:dismiss->function:hooks/use-toast.ts:dispatch` @hooks/use-toast.ts:190 — real function call (name matches)
  - `function:app/finance/page.tsx:handleFileSelect->function:hooks/use-toast.ts:toast` @app/finance/page.tsx:292 — real function call (name matches)
  - `function:app/finance/page.tsx:handleFileSelect->function:utils/fileHandling.ts:readFileAsBase64` @app/finance/page.tsx:306 — real function call (name matches)
  - `function:app/finance/page.tsx:handleFileSelect->function:utils/fileHandling.ts:readFileAsPDFText` @app/finance/page.tsx:310 — real function call (name matches)
  - `function:app/finance/page.tsx:handleFileSelect->function:utils/fileHandling.ts:readFileAsText` @app/finance/page.tsx:324 — real function call (name matches)
  - `function:hooks/use-toast.ts:useToast->function:hooks/use-toast.ts:toast` @hooks/use-toast.ts:189 — real method call (name matches)
  - `function:app/layout.tsx:RootLayout->function:components/theme-provider.tsx:ThemeProvider` @app/layout.tsx:33 — real method call (name matches)
  - `function:app/layout.tsx:RootLayout->function:components/ui/toaster.tsx:Toaster` @app/layout.tsx:40 — real method call (name matches)
  - `function:components/FilePreview.tsx:FilePreview->function:components/ui/badge.tsx:Badge` @components/FilePreview.tsx:38 — real method call (name matches)

ts-morph-only resolved edges the substrate MISSES (nesting-aware, genuine): 0

call-tree verdict: PASS (gate: recall ≥ 90.0% on both edges & method→method, AND substrate resolved-edge name-match ≥ 90.0%)

### Verdict: financial-data-analyst → PASS

## acme-admin
repo: `/path/to/acme/acme-admin`

### 1. Category counts (substrate vs ts-morph)

| category | substrate | ts-morph | verdict |
|---|--:|--:|:--|
| functions | 6634 | 4259 | PASS |
| classes | 383 | 382 | PASS |
| interfaces | 1198 | 1198 | PASS |
| typeAliases | 1915 | 1915 | PASS |
| enums | 289 | 289 | PASS |
| variables | 4707 | 4723 | PASS |
| entrypoints:http | 0 | 0 | PASS |
| entrypoints:queue | 0 | 0 | PASS |
| entrypoints:event | 0 | 0 | PASS |
| entrypoints:cli | 0 | 0 | PASS |
| entities | 0 | 0 | PASS |
| dbOperations | 0 | 0 | PASS |
| externalCalls | 2 | 2 | PASS |
| components | 1779 | 1766 | PASS |
| routes | 139 | 139 | PASS |
| routes(componentId-resolved) | 132 | 121 | PASS |
| stateStores | 8 | 8 | PASS |

validate-output: ts-morph valid=true errors=0 | substrate valid=true errors=0

### 1b. Category counts (substrate vs CURATED — production reference, not a gate)

| category | substrate | curated | delta (sub−cur) |
|---|--:|--:|--:|
| functions | 6634 | 4070 | +2564 |
| classes | 383 | 324 | +59 |
| interfaces | 1198 | 1193 | +5 |
| typeAliases | 1915 | 1997 | -82 |
| enums | 289 | 280 | +9 |
| variables | 4707 | 4652 | +55 |
| entrypoints:http | 0 | 0 | 0 |
| entrypoints:queue | 0 | 0 | 0 |
| entrypoints:event | 0 | 4 | -4 |
| entrypoints:cli | 0 | 0 | 0 |
| entities | 0 | 0 | 0 |
| dbOperations | 0 | 0 | 0 |
| externalCalls | 2 | 506 | -504 |
| components | 1779 | 1790 | -11 |
| routes | 139 | 95 | +44 |
| routes(componentId-resolved) | 132 | 95 | +37 |
| stateStores | 8 | 0 | +8 |

_Curated is a reference bar, not gospel — deltas surface the real production gap (dbOps, calls, externalCalls including internal-SDK egress); they do not gate decommission._

### 2. Call-tree (caller→callee) deep dive

resolved internal edges: substrate 11208 | ts-morph 5177
method→method edges:     substrate 11208 | ts-morph 5177

**resolved-edge name-match (callee node name == call expr): substrate 11206/11208 = 100.0% | ts-morph 5175/5177 = 100.0%**
(ts-morph resolves to the exact named callee; substrate resolves many `local N` / mismatched SCIP symbols onto real nodes — those resolved edges are spurious.)

**call-tree recall (resolved): 3887/3975 = 97.8%** (nesting-aware; exact-caller-id = 83.8%)
method→method recall: 3887/3975 = 97.8% (nesting-aware)

substrate-only resolved edges (extras): 4469
  of which name-match (plausibly genuine): 4467 | name-MISMATCH (noise): 2 (0.0%)
sample (classified):
  - `function:src/web-app.tsx:renderApp->method:src/utils/FontLoader.ts:FontLoader.load` @src/web-app.tsx:437 — real method call (name matches)
  - `function:src/utils/acmeDb.ts:upgrade->function:src/utils/acmeDb.ts:initStores` @src/utils/acmeDb.ts:48 — real function call (name matches)
  - `method:src/services/acme-api/acme-authed-api.ts:AcmeAuthedApi.constructor->method:src/services/acme-api/acme-authed-api.ts:AcmeAuthedApi.createMethods` @src/services/acme-api/acme-authed-api.ts:22 — real method call (name matches)
  - `method:src/services/amplitude/amplitude.ts:Amplitude.constructor->method:src/services/amplitude/amplitude.ts:Amplitude.createMappedMethods` @src/services/amplitude/amplitude.ts:93 — real method call (name matches)
  - `method:src/services/amplitude/tracking-library/index.ts:Ampli.client->method:src/services/amplitude/tracking-library/index.ts:Ampli.isInitializedAndEnabled` @src/services/amplitude/tracking-library/index.ts:1709 — real method call (name matches)
  - `function:src/mobile-web-app/index.tsx:getInitialRoute->function:src/mobile-web-app/index.tsx:getRouteFromQueryParam` @src/mobile-web-app/index.tsx:114 — real function call (name matches)
  - `function:src/mobile-web-app/index.tsx:getInitialRoute->function:src/utils/common.ts:isStonePartner` @src/mobile-web-app/index.tsx:147 — real function call (name matches)
  - `function:src/mobile-web-app/index.tsx:initializeMobile->function:src/mobile-web-app/utils/initMobile.ts:mobileLogin` @src/mobile-web-app/index.tsx:204 — real function call (name matches)
  - `function:src/mobile-web-app/index.tsx:initializeMobile->function:src/mobile-web-app/utils/initMobile.ts:initLocale` @src/mobile-web-app/index.tsx:206 — real function call (name matches)
  - `function:src/mobile-web-app/index.tsx:initializeMobile->function:src/mobile-web-app/utils/detectedCountry.ts:prefetchDetectedCountry` @src/mobile-web-app/index.tsx:217 — real function call (name matches)

ts-morph-only resolved edges the substrate MISSES (nesting-aware, genuine): 88
sample:
  - `function:src/web-app.tsx:renderApp->function:src/mobile-web-app/utils/viewport.ts:isMobileViewport` @src/web-app.tsx:496 (expr: isMobileViewport, method=false)
  - `function:src/routes/routingUtils.tsx:useOnboardingAbTestingSync->function:src/utils/localStorageUtils.ts:setObjectToLocalStorage` @src/routes/routingUtils.tsx:76 (expr: setObjectToLocalStorage, method=false)
  - `function:src/routes/routingUtils.tsx:useReducedOnboardingAbTestingSync->function:src/utils/localStorageUtils.ts:setObjectToLocalStorage` @src/routes/routingUtils.tsx:84 (expr: setObjectToLocalStorage, method=false)
  - `function:src/routes/routingUtils.tsx:getRouterWithRoutesByPermissions->function:src/components/OnboardingWizard/shared/utils/isOnboardingVisible.ts:isOnboardingVisible` @src/routes/routingUtils.tsx:276 (expr: isOnboardingVisible, method=false)
  - `function:src/utils/appInitHelpers.ts:setBetaFlag->function:src/utils/common.ts:urlParam` @src/utils/appInitHelpers.ts:394 (expr: urlParam, method=false)
  - `function:src/utils/appInitHelpers.ts:setEmbeddedFlag->function:src/utils/common.ts:urlParam` @src/utils/appInitHelpers.ts:409 (expr: urlParam, method=false)
  - `function:src/utils/common.ts:chunk->function:src/utils/common.ts:chunk` @src/utils/common.ts:646 (expr: chunk, method=false)
  - `function:src/utils/common.ts:getCrossShiftsPhaseLabel->function:src/utils/common.ts:minsToHrsMins` @src/utils/common.ts:664 (expr: minsToHrsMins, method=false)

call-tree verdict: PASS (gate: recall ≥ 90.0% on both edges & method→method, AND substrate resolved-edge name-match ≥ 90.0%)

### Verdict: acme-admin → PASS
---

## Fix 4 (generic-arg calls + dbOps enrich)

Two substrate gaps that flipped the acme-core cross-engine gate are now closed; the full
5-repo sweep above is **PASS across the board** (overall: ts-morph can be deleted).

### Fix #1 — generic-type-argument call extraction (structural)

**Root cause (corrected diagnosis):** the structural `call_expression` walker already reads the
`function`/`arguments` fields correctly when type args are present *without* `await`. The real
quirk is **`await` + type arguments**: the tree-sitter TS grammar mis-parses `await x.m<A, B>(…)`
so the `call_expression`'s `function` field is the whole `await_expression` (`await x.m`) instead
of the normal `await_expression > call_expression` nesting. The walker then read methodName =
`"await x.m"` with no receiver, mis-classifying the call as a bare callee — so axios/SDK egress
calls carrying type args (`axios.get<…>('/metrics')`, `this.axios.request<…>(…)`,
`this.httpService.axiosRef.post<…>(…)`) were dropped. Plain `await x.m()` (no type args) parses
normally and was unaffected.

**Fix** (`packages/code-graph/src/structural/ts-structural.ts`): in the `call_expression` case,
when the `function` field is an `await_expression`, unwrap it to the inner callee and set
`isAwaited`. Generic — no repo/SDK names. Regression test added.

**Result:** acme-core substrate externalCalls **36 → 39** (== ts-morph 39); the 3 recovered edges
are the genuine generic-arg axios calls. Substrate resolved-edge name-match stays **100%**. The 9
internal generic-arg `this.<op>()` calls these awaited sites also surfaced now classify as db
operations (MikroORM builtins with no internal callee), so resolved call-tree recall is unchanged
(96.8%).

### Fix #2 — dbOps enrichment (real misses only; plumbing stays dropped)

Two changes, both engines (`src/engine.ts` ts-morph + `src/substrate/engine.ts`), config-driven:

1. **`createQueryBuilder` → `query`** added to the acme-core (and acme-shifts) `dbOperations.opMap`.
   3 acme-core sites with a known entity arg now emit as `query` ops.
2. **Repo-base-class entity resolution** (generic, driven by new `dbOperations.repoBaseClasses`
   config — `['EntityRepository', 'BaseRepository']`): a concrete repo class
   `FooRepository extends BaseRepository<Foo>` binds entity `Foo` to its `this.<op>()` calls and to
   DI props typed as that repository. The entity comes from the class's generic type arg
   (surfaced via new `StructuralClass.extendsClass` / `SubstrateClass.extendsClass`), validated
   against known entities — so the bare type-param base (`BaseRepository<T>`) itself never maps,
   only concrete subclasses. No repo-specific names live in engine code.

By-design `em`-plumbing (persist/flush/begin/commit with no resolvable entity) stays dropped.

**Result:** acme-core dbOps **224 → 232** on BOTH engines (cross-engine PASS; 0 per-site
discrepancy), with `UserProfileObligations` correctly resolved on 6 ops and `unknown` down to 5.
vs-curated gap narrows from −120 to −112 (the remainder is the deliberately-dropped plumbing).
validate-output 0 errors both engines.

### Tests / typecheck
code-graph 86/86 (new await+type-args test), profile-parser 9/9 (acme-core gates updated:
dbOps 224→232, calls 1606→1597 as 9 repo builtins moved to dbOps), both typechecks clean.
