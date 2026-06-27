import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, Alert,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Feather } from '@expo/vector-icons';

import { colors, space, type as T } from '../theme';
import { Field, Button, Avatar } from '../components/ui';
import { useAuth } from '../lib/auth';
import * as api from '../lib/api';
import type { RootStackParamList } from '../navigation/types';

export default function EditProfileScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { user, profile, refreshProfile } = useAuth();

  const [name, setName] = useState(profile?.name ?? '');
  const [handle, setHandle] = useState(profile?.handle ?? '');
  const [saving, setSaving] = useState(false);

  const onSave = useCallback(async () => {
    if (!user) return;
    if (!name.trim()) {
      Alert.alert('Name required', 'Please enter your name.');
      return;
    }
    try {
      setSaving(true);
      await api.updateProfile(user.id, {
        name: name.trim(),
        handle: handle.trim() ? handle.trim().replace(/^@/, '') : null,
      });
      await refreshProfile();
      nav.goBack();
    } catch (e: any) {
      Alert.alert('Could not save', e?.message ?? 'Please try again.');
    } finally {
      setSaving(false);
    }
  }, [user, name, handle, refreshProfile, nav]);

  return (
    <SafeAreaView style={st.screen} edges={['top']}>
      <View style={st.header}>
        <Pressable onPress={() => nav.goBack()} hitSlop={8} style={st.back}>
          <Feather name="chevron-left" size={24} color={colors.text} />
        </Pressable>
        <Text style={st.headerTitle}>Personal information</Text>
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={st.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          <View style={st.avatarWrap}>
            <Avatar name={name || profile?.name} size={88} />
          </View>

          <Field
            label="Name"
            value={name}
            onChangeText={setName}
            placeholder="Your name"
            autoCapitalize="words"
          />
          <Field
            label="Handle"
            value={handle}
            onChangeText={setHandle}
            placeholder="yourhandle"
            autoCapitalize="none"
          />

          <Button title="Save changes" icon="check" onPress={onSave} loading={saving} style={{ marginTop: space.lg }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.lg, paddingVertical: space.md },
  headerTitle: { ...T.label, fontSize: 13, color: colors.text },
  back: { position: 'absolute', left: space.lg },
  content: { paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.huge },
  avatarWrap: { alignItems: 'center', marginBottom: space.xl },
});
