export type DevMockPersonaId = 'developer' | 'ba' | 'manager' | 'product-owner' | 'qa' | 'ui-ux';

export interface DevMockUser {
  id: DevMockPersonaId;
  oid: string;
  displayName: string;
  email: string;
  groupName: string;
  label: string;
}

export const DEV_MOCK_USERS: DevMockUser[] = [
  {
    id: 'developer',
    oid: 'dev-mock-oid-00000000-0000-0000-0000-000000000000',
    displayName: 'Dev User',
    email: 'dev@localhost',
    groupName: 'Developer',
    label: 'Developer',
  },
  {
    id: 'ba',
    oid: 'dev-mock-oid-00000000-0000-0000-0000-000000000001',
    displayName: 'BA Dev User',
    email: 'ba-dev@localhost',
    groupName: 'BA',
    label: 'BA',
  },
  {
    id: 'manager',
    oid: 'dev-mock-oid-00000000-0000-0000-0000-000000000002',
    displayName: 'Manager Dev User',
    email: 'manager-dev@localhost',
    groupName: 'Manager',
    label: 'Manager',
  },
  {
    id: 'product-owner',
    oid: 'dev-mock-oid-00000000-0000-0000-0000-000000000003',
    displayName: 'Product Owner Dev User',
    email: 'po-dev@localhost',
    groupName: 'Product-Owner',
    label: 'Product Owner',
  },
  {
    id: 'qa',
    oid: 'dev-mock-oid-00000000-0000-0000-0000-000000000004',
    displayName: 'QA Dev User',
    email: 'qa-dev@localhost',
    groupName: 'QA',
    label: 'QA',
  },
  {
    id: 'ui-ux',
    oid: 'dev-mock-oid-00000000-0000-0000-0000-000000000005',
    displayName: 'UI/UX Dev User',
    email: 'uiux-dev@localhost',
    groupName: 'UI/UX',
    label: 'UI/UX',
  },
];

export const DEV_MOCK_USER_BY_ID = new Map(DEV_MOCK_USERS.map((u) => [u.id, u]));

export const DEV_MOCK_OIDS = new Set(DEV_MOCK_USERS.map((u) => u.oid));
