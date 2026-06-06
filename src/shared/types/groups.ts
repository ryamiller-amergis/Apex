export interface AppGroup {
  id: string;
  name: string;
  description: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface GroupMember {
  groupId: string;
  userId: string;
  displayName: string | null;
  email: string | null;
  addedBy: string | null;
  addedAt: string;
}

export interface GroupWithMembers extends AppGroup {
  members: GroupMember[];
}

export interface CreateGroupRequest {
  name: string;
  description?: string;
}

export interface UpdateGroupRequest {
  name?: string;
  description?: string;
}

export interface SetGroupMembersRequest {
  userIds: string[];
}
