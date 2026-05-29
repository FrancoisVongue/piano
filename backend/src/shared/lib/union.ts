export namespace Union {
  // Export types directly from the namespace
  export type Definition = Record<string, any>;
  // Create a union type where only one key from the definition can be present
  export type Variant<TDefinition extends Definition> = {
    [K in keyof TDefinition]: { [P in K]: TDefinition[K] } & { [P in Exclude<keyof TDefinition, K>]?: never }
  }[keyof TDefinition];

  export type ActiveVariantEntry<TDefinition extends Definition> = 
    | { [K in keyof TDefinition]: { tag: K; data: TDefinition[K] } }[keyof TDefinition]
    | undefined;

  export function getActiveVariant<TDefinition extends Definition>(
    unionValue: Variant<TDefinition>
  ): ActiveVariantEntry<TDefinition> {
    for (const key in unionValue) {
      if (Object.prototype.hasOwnProperty.call(unionValue, key)) {
        const tagName = key as keyof TDefinition;
        const variantData = unionValue[tagName];

        if (tagName in unionValue && variantData !== undefined) {
          return {
            tag: tagName,
            data: variantData as TDefinition[typeof tagName]
          } as ActiveVariantEntry<TDefinition>;
        }
      }
    }
    return undefined;
  }

  // Handler types for match function
  export type VariantHandlers<TDefinition extends Definition, TResult> = {
    [K in keyof TDefinition]: (data: TDefinition[K]) => TResult
  };

  export type DefaultHandler<TDefinition extends Definition, TResult> = {
    _: (data: TDefinition[keyof TDefinition]) => TResult
  };

  // Updated match with better generic constraints
  export const match = <TDefinition extends Definition, TResult>(
    handlers: 
      | VariantHandlers<TDefinition, TResult>
      | (Partial<VariantHandlers<TDefinition, TResult>> & DefaultHandler<TDefinition, TResult>),
    unionValue: Variant<TDefinition>
  ): TResult => {
    const activeVariant = getActiveVariant(unionValue);
    
    if (activeVariant) {
      const variantHandler = (handlers as any)[activeVariant.tag];
      if (variantHandler !== undefined) {
        return variantHandler(activeVariant.data);
      }
    }
    
    if ('_' in handlers && handlers._) {
      return handlers._(activeVariant?.data as any);
    }

    const activeTag = activeVariant ? activeVariant.tag : 'none';
    throw new Error(`Handler not found for active tag "${String(activeTag)}" and no default '_' handler was provided.`);
  };
}

// example usage 
// type ReturnOfSomeFunction = {
//   success: string;
//   wrongUser: {explanation: string, err: string}
//   wrongNote: {err: string}
// }

// const result = Union.match<ReturnOfSomeFunction, string>({
//   success: (data) => data,
//   wrongUser: (data) => data.err,
//   '_': (data) => 'default ansewr'
// }, 1 as any as Union.Variant<ReturnOfSomeFunction>);
