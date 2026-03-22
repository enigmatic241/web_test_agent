import { z } from 'zod';

const pageSchema = z.object({
  slug: z.string().min(1),
  url: z.string().url(),
  name: z.string().min(1),
});

export type PageConfig = z.infer<typeof pageSchema>;

/**
 * Target pages — URLs must not be hardcoded outside this file.
 */
export const PAGES: PageConfig[] = [
  { slug: 'homepage', url: 'https://www.indiamart.com', name: 'Homepage' },
  {
    slug: 'search',
    url: 'https://www.indiamart.com/search.mp?ss=steel+pipes',
    name: 'Search results',
  },
  {
    slug: 'product-listing',
    url: 'https://www.indiamart.com/proddetail/',
    name: 'Product listing',
  },
  {
    slug: 'supplier-detail',
    url: 'https://www.indiamart.com/companyname/',
    name: 'Supplier detail',
  },
  {
    slug: 'category',
    url: 'https://www.indiamart.com/industrial-machinery/',
    name: 'Category browse',
  },
].map((p) => pageSchema.parse(p));
