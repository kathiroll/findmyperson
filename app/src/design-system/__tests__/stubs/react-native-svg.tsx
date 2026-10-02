import { createElement, type ReactNode } from 'react';

const host = (name: string) => {
  const Component = ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) =>
    createElement(name, props, children);
  Component.displayName = name;
  return Component;
};

export const Path = host('Path');
export const Circle = host('Circle');
export default host('Svg');
