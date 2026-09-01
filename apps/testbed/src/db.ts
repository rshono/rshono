export interface User {
  id: string;
  name: string;
  email: string;
  avatar: string;
}

export interface Post {
  id: string;
  title: string;
  excerpt: string;
}

const users: User[] = [
  { id: '1', name: 'Ada Lovelace', email: 'ada@example.com', avatar: '🦉' },
  { id: '2', name: 'Alan Turing', email: 'alan@example.com', avatar: '🤖' },
  { id: '3', name: 'Grace Hopper', email: 'grace@example.com', avatar: '🚢' },
];

const posts: Post[] = [
  { id: 'p1', title: 'On the Origins of Computing', excerpt: 'An exploration into the analytical engine...' },
  { id: 'p2', title: 'Breaking the Code', excerpt: 'How pattern recognition shaped modern...' },
];

export interface Doc {
  slug: string;
  title: string;
  body: string;
  /** Anchored headings. These are what the on-page contents links at, and what `/docs/x#y` lands on. */
  sections: Array<{ id: string; title: string }>;
}

const docs: Doc[] = [
  {
    slug: 'getting-started',
    title: 'Getting Started',
    body: 'Install, create routes.ts, run the dev server.',
    sections: [
      { id: 'install', title: 'Install' },
      { id: 'routes', title: 'Routes' },
      { id: 'dev-server', title: 'Dev server' },
    ],
  },
  {
    slug: 'deployment',
    title: 'Deployment',
    body: 'Run `rs-hono build`, then `rs-hono start` on your server.',
    sections: [
      { id: 'build', title: 'Build' },
      { id: 'serve', title: 'Serve' },
      { id: 'targets', title: 'Targets' },
    ],
  },
  {
    // A slug that has to be percent-encoded to travel in a URL, and so has to survive the round trip from
    // `staticPaths` to the file on disk to `c.req.path`. Every deploy target is asserted against this one:
    // when the writer and the reader disagreed about encoding, a page like this was built and never served.
    slug: 'café',
    title: 'Café',
    body: 'A page whose slug is not ASCII, so prerendering it proves the encoding round trip.',
    sections: [
      { id: 'encoding', title: 'Encoding' },
      { id: 'on-disk', title: 'On disk' },
      { id: 'serving', title: 'Serving' },
    ],
  },
];

export const fakeDB = {
  async getUser(id: string): Promise<User | undefined> {
    return users.find((u) => u.id === id);
  },

  async listUsers(): Promise<User[]> {
    return users;
  },

  async getUserPosts(_userId: string): Promise<Post[]> {
    return posts;
  },

  async createUser(data: { name: string; email: string }): Promise<User> {
    const user: User = { id: String(users.length + 1), ...data, avatar: '✨' };
    users.push(user);
    return user;
  },

  async listDocs(): Promise<Doc[]> {
    return docs;
  },

  async getDoc(slug: string): Promise<Doc | undefined> {
    return docs.find((d) => d.slug === slug);
  },
};
