import { CustomDecorator, SetMetadata } from '@nestjs/common';

/** Metadata key set by {@link Public}. */
export const IS_PUBLIC_KEY = 'identity:isPublic';

/**
 * Marks a handler or a whole controller as public: no token is read and no role is checked.
 * Every route must carry either this or `@Roles(...)`, otherwise startup fails.
 */
export const Public = (): CustomDecorator<string> => SetMetadata(IS_PUBLIC_KEY, true);
