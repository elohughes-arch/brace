import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { colors, space, radius, type as T } from '../theme';
import { Screen, Card, ListRow, Button, Avatar, Tag, Label } from '../components/ui';
import { useAuth } from '../lib/auth';
import type { RootStackParamList } from '../navigation/types';

const APP_VERSION = '1.0.0';

export default function AccountScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { user, profile, signOut } = useAuth();

  const name = profile?.name?.trim() || 'Founding member';
  const handle = profile?.handle?.trim();
  const email = user?.email ?? '';

  return (
    <Screen title="Account">
      {/* Profile header */}
      <Card style={st.profile}>
        <Avatar name={profile?.name} size={64} />
        <View style={{ flex: 1, marginLeft: space.lg }}>
          <Text style={st.name} numberOfLines={1}>{name}</Text>
          {handle ? <Text style={st.handle} numberOfLines={1}>@{handle}</Text> : null}
          {email ? <Text style={st.email} numberOfLines={1}>{email}</Text> : null}
          <View style={st.chipRow}>
            <Tag color={colors.amber} solid>Founding Member</Tag>
          </View>
        </View>
      </Card>

      {/* Account group */}
      <Label>Account</Label>
      <View style={st.group}>
        <ListRow
          icon="user"
          title="Personal information"
          subtitle="Name, handle"
          onPress={() => nav.navigate('EditProfile')}
        />
        <ListRow
          icon="shield"
          title="Privacy settings"
          subtitle="Data controls, GDPR"
          onPress={() => nav.navigate('Privacy')}
        />
        <ListRow
          icon="award"
          title="Membership"
          subtitle="Plan & benefits"
          onPress={() => nav.navigate('Membership')}
        />
      </View>

      {/* Support group */}
      <Label>Support</Label>
      <View style={st.group}>
        <ListRow
          icon="life-buoy"
          title="Customer support"
          subtitle="Get in touch"
          onPress={() => nav.navigate('Support')}
        />
        <ListRow
          icon="help-circle"
          title="FAQ & tutorials"
          onPress={() => nav.navigate('Support')}
        />
        <ListRow
          icon="info"
          title="About Brace"
          onPress={() => nav.navigate('Support')}
        />
      </View>

      {/* Logout */}
      <Button
        title="Log out"
        variant="outline"
        icon="log-out"
        color={colors.red}
        onPress={() => signOut()}
        style={{ marginTop: space.xl }}
      />

      <Text style={st.version}>Brace v{APP_VERSION}</Text>
    </Screen>
  );
}

const st = StyleSheet.create({
  profile: { flexDirection: 'row', alignItems: 'center', marginTop: space.sm, marginBottom: space.lg },
  name: { ...T.h2 },
  handle: { ...T.small, color: colors.primary, marginTop: 2 },
  email: { ...T.small, marginTop: 2 },
  chipRow: { flexDirection: 'row', marginTop: space.sm },
  group: { marginTop: space.sm, marginBottom: space.md },
  version: { ...T.small, color: colors.textDim, textAlign: 'center', marginTop: space.xl },
});
