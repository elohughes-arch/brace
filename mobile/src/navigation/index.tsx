import React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Feather } from '@expo/vector-icons';
import { colors } from '../theme';
import { useAuth } from '../lib/auth';
import type { RootStackParamList, TabParamList } from './types';

import AuthScreen from '../screens/AuthScreen';
import OnboardingScreen from '../screens/OnboardingScreen';
import HomeScreen from '../screens/HomeScreen';
import AnalyseScreen from '../screens/AnalyseScreen';
import CommunityScreen from '../screens/CommunityScreen';
import ShootsScreen from '../screens/ShootsScreen';
import AccountScreen from '../screens/AccountScreen';
import SessionDetailScreen from '../screens/SessionDetailScreen';
import GroupScreen from '../screens/GroupScreen';
import ForumScreen from '../screens/ForumScreen';
import CreateGroupScreen from '../screens/CreateGroupScreen';
import VenueDetailScreen from '../screens/VenueDetailScreen';
import EditProfileScreen from '../screens/EditProfileScreen';
import PrivacyScreen from '../screens/PrivacyScreen';
import MembershipScreen from '../screens/MembershipScreen';
import SupportScreen from '../screens/SupportScreen';

const Tab = createBottomTabNavigator<TabParamList>();
const Stack = createNativeStackNavigator<RootStackParamList>();

const TAB_ICON: Record<keyof TabParamList, React.ComponentProps<typeof Feather>['name']> = {
  Home: 'home', Analyse: 'bar-chart-2', Community: 'users', Shoots: 'map-pin', Account: 'user',
};

function Tabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textDim,
        tabBarStyle: { backgroundColor: colors.bgElevated, borderTopColor: colors.border, height: 84, paddingTop: 8 },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
        tabBarIcon: ({ color, size }) => <Feather name={TAB_ICON[route.name]} size={size} color={color} />,
      })}
    >
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Analyse" component={AnalyseScreen} />
      <Tab.Screen name="Community" component={CommunityScreen} />
      <Tab.Screen name="Shoots" component={ShootsScreen} />
      <Tab.Screen name="Account" component={AccountScreen} />
    </Tab.Navigator>
  );
}

export default function RootNavigator() {
  const { loading, session, profile } = useAuth();

  if (loading) {
    return <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={colors.primary} /></View>;
  }
  if (!session) return <AuthScreen />;
  if (!profile?.onboarded) return <OnboardingScreen />;

  return (
    <Stack.Navigator screenOptions={{ headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text, headerTitleStyle: { fontWeight: '700' }, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />
      <Stack.Screen name="SessionDetail" component={SessionDetailScreen} options={{ title: 'Session' }} />
      <Stack.Screen name="Group" component={GroupScreen} options={{ title: 'Group' }} />
      <Stack.Screen name="Forum" component={ForumScreen} options={{ title: 'Community' }} />
      <Stack.Screen name="CreateGroup" component={CreateGroupScreen} options={{ title: 'New Group', presentation: 'modal' }} />
      <Stack.Screen name="VenueDetail" component={VenueDetailScreen} options={{ title: 'Venue' }} />
      <Stack.Screen name="EditProfile" component={EditProfileScreen} options={{ title: 'Profile' }} />
      <Stack.Screen name="Privacy" component={PrivacyScreen} options={{ title: 'Privacy' }} />
      <Stack.Screen name="Membership" component={MembershipScreen} options={{ title: 'Membership' }} />
      <Stack.Screen name="Support" component={SupportScreen} options={{ title: 'Support' }} />
    </Stack.Navigator>
  );
}
