import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';

export async function GET(context) {
  const posts = (await getCollection('blog', ({ data }) => !data.draft)).sort(
    (a, b) => b.data.fecha.valueOf() - a.data.fecha.valueOf(),
  );

  return rss({
    title: 'regardless — blog',
    description: 'Notas técnicas y no técnicas desde el lab.',
    site: context.site,
    items: posts.map((post) => ({
      title: post.data.title,
      pubDate: post.data.fecha,
      description: post.data.resumen,
      categories: [post.data.tipo],
      link: `/blog/${post.id}/`,
    })),
    customData: '<language>es-cl</language>',
  });
}
