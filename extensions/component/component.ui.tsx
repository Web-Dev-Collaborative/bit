import React from 'react';
import { RouteProps, NavLinkProps } from 'react-router-dom';
import { Slot } from '@teambit/harmony';
import { Component } from './ui/component';
import { RouteSlot, NavigationSlot } from '@bit/bit.core.react-router/slot-router';

export type Server = {
  env: string;
  url: string;
};

export type ComponentMeta = {
  id: string;
};

export type MenuItem = {
  label: JSX.Element | string | null;
};

export const componentIdUrlRegex = '[\\w\\/-]*[\\w-]';

export class ComponentUI {
  constructor(private routeSlot: RouteSlot, private navSlot: NavigationSlot, private widgetSlot: NavigationSlot) {}

  readonly routePath = `/:componentId(${componentIdUrlRegex})`;

  getComponentUI(host: string) {
    return <Component navSlot={this.navSlot} routeSlot={this.routeSlot} widgetSlot={this.widgetSlot} host={host} />;
  }

  registerRoute(route: RouteProps) {
    this.routeSlot.register(route);
    return this;
  }

  registerNavigation(nav: NavLinkProps) {
    this.navSlot.register(nav);
  }

  registerWidget(widget: NavLinkProps) {
    this.widgetSlot.register(widget);
  }

  static dependencies = [];

  static slots = [Slot.withType<RouteProps>(), Slot.withType<NavigationSlot>(), Slot.withType<NavigationSlot>()];

  static async provider(deps, config, [routeSlot, navSlot, widgetSlot]: [RouteSlot, NavigationSlot, NavigationSlot]) {
    const componentUI = new ComponentUI(routeSlot, navSlot, widgetSlot);
    return componentUI;
  }
}

export default ComponentUI;
