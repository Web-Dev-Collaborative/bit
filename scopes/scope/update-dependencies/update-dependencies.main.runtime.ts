import mapSeries from 'p-map-series';
import { flatten } from 'lodash';
import { CLIAspect, CLIMain, MainRuntime } from '@teambit/cli';
import { LoggerAspect, LoggerMain, Logger } from '@teambit/logger';
import { ScopeAspect, ScopeMain, ComponentNotFound } from '@teambit/scope';
import { BuilderAspect, BuilderMain } from '@teambit/builder';
import { Component, ComponentID } from '@teambit/component';
import {
  getPublishedPackages,
  updateComponentsByTagResult,
  addFlattenedDependenciesToComponents,
} from 'bit-bin/dist/scope/component-ops/tag-model-component';
import ConsumerComponent from 'bit-bin/dist/consumer/component';
import { BuildStatus, LATEST } from 'bit-bin/dist/constants';
import { getScopeRemotes } from 'bit-bin/dist/scope/scope-remotes';
import { PostSign } from 'bit-bin/dist/scope/actions';
import { Remotes } from 'bit-bin/dist/remotes';
import { BitIds, BitId } from 'bit-bin/dist/bit-id';
import { getValidVersionOrReleaseType } from 'bit-bin/dist/utils/semver-helper';
import { DependencyResolverAspect, DependencyResolverMain } from '@teambit/dependency-resolver';
import { exportMany } from 'bit-bin/dist/scope/component-ops/export-scope-components';
import { ExtensionDataEntry } from 'bit-bin/dist/consumer/config';
import { UpdateDependenciesCmd } from './update-dependencies.cmd';
import { UpdateDependenciesAspect } from './update-dependencies.aspect';

export type UpdateDepsOptions = {
  tag?: boolean;
  snap?: boolean;
  output?: string;
  multiple?: boolean;
  message?: string;
  username?: string;
  email?: string;
};

export type DepUpdateItemRaw = {
  componentId: string; // ids always have scope, so it's safe to parse them from string
  dependencies: string[]; // e.g. [@teambit/compiler@~1.0.0, @teambit/tester@^1.0.0]
  versionToTag?: string; // specific version or semver. e.g. '1.0.0', 'minor',
};

export type DepUpdateItem = {
  component: Component;
  dependencies: ComponentID[];
  versionToTag?: string;
};

export type UpdateDepsResult = {
  depsUpdateItems: DepUpdateItem[];
  publishedPackages: string[];
  error: string | null;
};

export class UpdateDependenciesMain {
  private depsUpdateItems: DepUpdateItem[];
  private updateDepsOptions: UpdateDepsOptions;
  constructor(
    private scope: ScopeMain,
    private logger: Logger,
    private builder: BuilderMain,
    private dependencyResolver: DependencyResolverMain
  ) {}

  async updateDependenciesVersions(
    depsUpdateItemsRaw: DepUpdateItemRaw[],
    updateDepsOptions: UpdateDepsOptions
  ): Promise<UpdateDepsResult> {
    this.updateDepsOptions = updateDepsOptions;
    await this.importAllMissing(depsUpdateItemsRaw);
    this.depsUpdateItems = await this.parseDevUpdatesItems(depsUpdateItemsRaw);
    await this.updateFutureVersion();
    await this.updateAllDeps();
    this.addLogToComponents();
    await addFlattenedDependenciesToComponents(this.scope.legacyScope, this.legacyComponents);
    this.addBuildStatus();
    await this.addComponentsToScope();
    await this.updateComponents();
    const { builderDataMap, pipeResults } = await this.builder.tagListener(
      this.components,
      { throwOnError: true }, // we might change it later to not throw.
      { seedersOnly: true }
    );
    const legacyBuildResults = this.scope.builderDataMapToLegacyOnTagResults(builderDataMap);
    updateComponentsByTagResult(this.legacyComponents, legacyBuildResults);
    const publishedPackages = getPublishedPackages(this.legacyComponents);
    const pipeWithError = pipeResults.find((pipe) => pipe.hasErrors());
    const buildStatus = pipeWithError ? BuildStatus.Failed : BuildStatus.Succeed;
    await this.saveDataIntoLocalScope(buildStatus);
    if (updateDepsOptions.multiple) {
      await this.export();
    } else {
      await this.clearScopesCaches();
    }

    return {
      depsUpdateItems: this.depsUpdateItems,
      publishedPackages,
      error: pipeWithError ? pipeWithError.getErrorMessageFormatted() : null,
    };
  }

  get legacyComponents(): ConsumerComponent[] {
    return this.depsUpdateItems.map((d) => d.component.state._consumer);
  }
  get components(): Component[] {
    return this.depsUpdateItems.map((d) => d.component);
  }

  private async importAllMissing(depsUpdateItemsRaw: DepUpdateItemRaw[]) {
    const componentIds = depsUpdateItemsRaw.map((d) => ComponentID.fromString(d.componentId));
    const dependenciesIds = depsUpdateItemsRaw.map((item) =>
      item.dependencies.map((dep) => ComponentID.fromString(dep)).map((id) => id.changeVersion(LATEST))
    );
    const idsToImport = flatten(dependenciesIds);
    if (this.updateDepsOptions.multiple) idsToImport.push(...componentIds);
    // do not use cache. for dependencies we must fetch the latest ModelComponent from the remote
    // in order to match the semver later.
    await this.scope.import(idsToImport, false);
  }

  private async addComponentsToScope() {
    await mapSeries(this.legacyComponents, (component) => this.scope.legacyScope.sources.addSourceFromScope(component));
  }

  private async updateComponents() {
    await mapSeries(this.depsUpdateItems, async (depUpdateItem) => {
      const legacyComp: ConsumerComponent = depUpdateItem.component.state._consumer;
      depUpdateItem.component = await this.scope.getFromConsumerComponent(legacyComp);
    });
  }

  private addBuildStatus() {
    this.legacyComponents.forEach((c) => {
      c.buildStatus = BuildStatus.Pending;
    });
  }

  private addLogToComponents() {
    this.legacyComponents.forEach((component) => {
      component.log = {
        username: this.updateDepsOptions.username || 'ci',
        email: this.updateDepsOptions.email || 'ci@bit.dev',
        message: this.updateDepsOptions.message || 'update-dependencies',
        date: Date.now().toString(),
      };
    });
  }

  private async updateAllDeps() {
    const components = this.depsUpdateItems.map((d) => d.component);
    // current bit ids are needed because we might update multiple components that are depend on
    // each other. in which case, we want the dependency version to be the same as the currently
    // tagged/snapped component.
    const currentBitIds = components.map((c) => c.id._legacy);
    await mapSeries(this.depsUpdateItems, async ({ component, dependencies }) => {
      await this.updateDependenciesVersionsOfComponent(component, dependencies, currentBitIds);
      await this.updateDependencyResolver(component);
    });
  }

  private async parseDevUpdatesItems(depsUpdateItemsRaw: DepUpdateItemRaw[]): Promise<DepUpdateItem[]> {
    return mapSeries(depsUpdateItemsRaw, async (depUpdateItemRaw) => {
      const componentId = ComponentID.fromString(depUpdateItemRaw.componentId);
      const component = await this.scope.get(componentId);
      if (!component) throw new ComponentNotFound(componentId);
      const dependencies = await Promise.all(
        depUpdateItemRaw.dependencies.map((dep) => this.getDependencyWithExactVersion(dep))
      );
      return { component, dependencies, versionToTag: depUpdateItemRaw.versionToTag };
    });
  }

  private async getDependencyWithExactVersion(depStr: string): Promise<ComponentID> {
    const compId = ComponentID.fromString(depStr);
    const range = compId.version || '*'; // if not version specified, assume the latest
    const id = compId.changeVersion(undefined);
    const exactVersion = await this.scope.getExactVersionBySemverRange(id, range);
    if (!exactVersion) {
      throw new Error(`unable to find a version that satisfies "${range}" of "${depStr}"`);
    }
    return compId.changeVersion(exactVersion);
  }

  private async updateFutureVersion() {
    await mapSeries(this.depsUpdateItems, async (depUpdateItem) => {
      const legacyComp: ConsumerComponent = depUpdateItem.component.state._consumer;
      const modelComponent = await this.scope.legacyScope.getModelComponent(legacyComp.id);
      if (this.updateDepsOptions.tag) {
        const { releaseType, exactVersion } = getValidVersionOrReleaseType(depUpdateItem.versionToTag || 'patch');
        legacyComp.version = modelComponent.getVersionToAdd(releaseType, exactVersion);
      } else {
        legacyComp.version = modelComponent.getSnapToAdd();
      }
    });
  }

  private async updateDependencyResolver(component: Component) {
    const dependencies = await this.dependencyResolver.extractDepsFromLegacy(component);
    const extId = DependencyResolverAspect.id;
    const data = { dependencies };
    const existingExtension = component.state._consumer.extensions.findExtension(extId);
    if (existingExtension) {
      // Only merge top level of extension data
      Object.assign(existingExtension.data, data);
      return;
    }
    const extension = new ExtensionDataEntry(undefined, undefined, extId, undefined, data);
    component.state._consumer.extensions.push(extension);
  }

  private async updateDependenciesVersionsOfComponent(
    component: Component,
    dependencies: ComponentID[],
    currentBitIds: BitId[]
  ) {
    const depsBitIds = dependencies.map((d) => d._legacy);
    const updatedIds = BitIds.fromArray([...currentBitIds, ...depsBitIds]);
    const componentIdStr = component.id.toString();
    const legacyComponent: ConsumerComponent = component.state._consumer;
    const deps = [...legacyComponent.dependencies.get(), ...legacyComponent.devDependencies.get()];
    const dependenciesList = await this.dependencyResolver.getDependencies(component);
    deps.forEach((dep) => {
      const updatedBitId = updatedIds.searchWithoutVersion(dep.id);
      if (updatedBitId) {
        const depIdStr = dep.id.toString();
        const packageName = dependenciesList.findDependency(depIdStr)?.getPackageName?.();
        if (!packageName) {
          throw new Error(
            `unable to find the package-name of "${depIdStr}" dependency inside the dependency-resolver data of "${componentIdStr}"`
          );
        }
        this.logger.debug(`updating "${componentIdStr}", dependency ${depIdStr} to version ${updatedBitId.version}}`);
        dep.id = updatedBitId;
        dep.packageName = packageName;
      }
    });
    legacyComponent.extensions.forEach((ext) => {
      if (!ext.extensionId) return;
      const updatedBitId = updatedIds.searchWithoutVersion(ext.extensionId);
      if (updatedBitId) {
        this.logger.debug(
          `updating "${componentIdStr}", extension ${ext.extensionId.toString()} to version ${updatedBitId.version}}`
        );
        ext.extensionId = updatedBitId;
      }
    });
  }

  private async clearScopesCaches() {
    const bitIds = BitIds.fromArray(this.legacyComponents.map((c) => c.id));
    const idsGroupedByScope = bitIds.toGroupByScopeName(new BitIds());
    const scopeRemotes: Remotes = await getScopeRemotes(this.scope.legacyScope);
    await Promise.all(
      Object.keys(idsGroupedByScope).map(async (scopeName) => {
        const remote = await scopeRemotes.resolve(scopeName, this.scope.legacyScope);
        return remote.action(PostSign.name, { ids: idsGroupedByScope[scopeName].map((id) => id.toString()) });
      })
    );
  }

  private async saveDataIntoLocalScope(buildStatus: BuildStatus) {
    await mapSeries(this.legacyComponents, async (component) => {
      component.buildStatus = buildStatus;
      await this.scope.legacyScope.sources.enrichSource(component);
    });
    await this.scope.legacyScope.objects.persist();
  }

  private async export() {
    const ids = BitIds.fromArray(this.legacyComponents.map((c) => c.id));
    await exportMany({
      scope: this.scope.legacyScope,
      isLegacy: false,
      ids,
      codemod: false,
      changeLocallyAlthoughRemoteIsDifferent: false,
      includeDependencies: false,
      remoteName: null,
      idsWithFutureScope: ids,
      allVersions: false,
    });
  }

  static runtime = MainRuntime;

  static dependencies = [CLIAspect, ScopeAspect, LoggerAspect, BuilderAspect, DependencyResolverAspect];

  static async provider([cli, scope, loggerMain, builder, dependencyResolver]: [
    CLIMain,
    ScopeMain,
    LoggerMain,
    BuilderMain,
    DependencyResolverMain
  ]) {
    const logger = loggerMain.createLogger(UpdateDependenciesAspect.id);
    const updateDependenciesMain = new UpdateDependenciesMain(scope, logger, builder, dependencyResolver);
    cli.register(new UpdateDependenciesCmd(updateDependenciesMain, scope, logger));
    return updateDependenciesMain;
  }
}

UpdateDependenciesAspect.addRuntime(UpdateDependenciesMain);
