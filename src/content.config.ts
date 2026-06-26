import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    // fecha de publicación
    fecha: z.coerce.date(),
    // clasificación: define en qué pestaña aparece y la etiqueta visible
    tipo: z.enum(['técnico', 'no-técnico']),
    // bajada breve que se muestra en el listado
    resumen: z.string().optional(),
    // ocúltalo del listado mientras lo escribes
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };
