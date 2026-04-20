/**
 * Written to every `AnimationGroup.metadata` from a character GLB import
 * ({@link CharacterLoader.tagCharacterAnimationGroups}): locomotion clips **and** any
 * community emotes / custom clips in the same file share this tag so cached character swaps
 * resolve the correct rig (`AnimationController.resolveTaggedForCurrentCharacter`).
 */
export const CHARACTER_ANIM_META_KEY = 'babylon_game_starter_character_name' as const;
