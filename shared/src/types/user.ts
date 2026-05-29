import { z } from 'zod';

export namespace User {
  // ============================================
  // CORE MODEL
  // ============================================
  
  export interface Model {
    id: string;
    email: string;
    name?: string;
    /**
     * Default system prompt prepended to every AI run, regardless of which
     * arrangement the run happens in. Composed at the action worker layer:
     *   [user.defaultSystemPrompt] → [arrangement.systemPrompt] → [action.prompt] → [content]
     */
    defaultSystemPrompt?: string | null;
    createdAt: Date;
    updatedAt: Date;
  }

  // ============================================
  // PROFILE UPDATE DTO
  // ============================================

  export namespace DTO {
    export const UpdateProfileSchema = z.object({
      name: z.string().trim().min(1).max(100).optional(),
      defaultSystemPrompt: z.string().max(10000).nullable().optional(),
    });
    export type UpdateProfile = z.infer<typeof UpdateProfileSchema>;
  }

  // ============================================
  // SESSION TYPE (for auth context)
  // ============================================

  export interface Session {
    id: string;
    email: string;
    name?: string;
  }

  // ============================================
  // AUTH DTOs (what frontend sends)
  // ============================================

  export namespace Auth {
    export const SignInSchema = z.object({
      email: z.string().email(),
      password: z.string().min(1),
    });

    export const SignUpSchema = z.object({
      email: z.string().email(),
      password: z.string().min(6),
      name: z.string().optional(),
    });

    export type SignIn = z.infer<typeof SignInSchema>;
    export type SignUp = z.infer<typeof SignUpSchema>;
  }

  // ============================================
  // VALIDATION & CREATION  
  // ============================================
  
  export const validate = {
    signIn: (data: unknown): Auth.SignIn => Auth.SignInSchema.parse(data),
    signUp: (data: unknown): Auth.SignUp => Auth.SignUpSchema.parse(data),
    updateProfile: (data: unknown): DTO.UpdateProfile => DTO.UpdateProfileSchema.parse(data),
  };

  export const create = (data: Auth.SignUp): Omit<Model, 'id' | 'createdAt' | 'updatedAt'> => ({
    email: data.email,
    name: data.name,
  });
}
